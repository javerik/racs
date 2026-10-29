//! Periodic housekeeping: ending sessions that stopped sending heartbeats, closing devices nobody
//! uses, and dropping expired burst jobs.
//!
//! Spawned by `main` and the fake server; its intervals come from
//! [`RuntimeConfig`](crate::server_config::RuntimeConfig), so the tests run it in milliseconds.

use std::time::Instant;

use tracing::{debug, warn};

use crate::app_context::AppContext;

/// What one [`sweep`] did.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct SweepReport {
    pub sessions_expired: usize,
    pub devices_closed: Vec<u32>,
    pub jobs_expired: usize,
}

/// One round of housekeeping at `now`.
pub async fn sweep(ctx: &AppContext, now: Instant) -> SweepReport {
    let mut report = SweepReport { sessions_expired: ctx.clients.expire(now), ..Default::default() };

    if let Some(timeout) = ctx.runtime.device_idle_timeout {
        for id in ctx.clients.idle_devices(now, timeout) {
            // Checked again under the device's lifecycle lock: a request may have come in since.
            match ctx.dev_ctrl.close_if_idle(id, timeout).await {
                Ok(true) => report.devices_closed.push(id),
                Ok(false) => {}
                Err(e) => warn!("closing idle device {id} failed => {e}"),
            }
        }
    }

    // Burst jobs are held in memory, so a client that starts jobs and never collects or deletes
    // them would otherwise grow the process without bound. Nothing else reclaims them.
    report.jobs_expired = ctx.job_store.sweep_expired();

    if report != SweepReport::default() {
        debug!("maintenance sweep: {report:?}");
    }
    report
}

/// Run [`sweep`] every `sweep_interval` for as long as the runtime lives.
pub fn spawn(ctx: AppContext) -> actix_web::rt::task::JoinHandle<()> {
    actix_web::rt::spawn(async move {
        let mut ticker = tokio::time::interval(ctx.runtime.sweep_interval);
        ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            ticker.tick().await;
            sweep(&ctx, Instant::now()).await;
        }
    })
}
