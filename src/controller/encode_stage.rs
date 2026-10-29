//! Encoding frames in parallel, in capture order, off the capture thread.
//!
//! A capture loop (live stream, burst) must get back to popping buffers quickly: the GVSP pool
//! holds only a handful of them, and the reassembler drops whole frames once it runs dry. So the
//! loop only copies a frame out of its buffer and hands the encoding on as a [`Staged::Work`]
//! item, over a bounded channel. [`ordered`] runs up to [`encode_parallelism`] of those at once on
//! the blocking thread pool and yields the results in the order they were handed on, so frame
//! numbers, burst indices and the stream-info messages between frames keep their places.

use std::sync::OnceLock;

use futures::{Stream, StreamExt};
use tokio::sync::mpsc::Receiver;

use crate::controller::stream_ctrl::StreamCtrlError;

/// One item a capture loop hands on, in capture order.
pub enum Staged<M> {
    /// Passed through as it is: nothing to encode (stream info, a raw frame, a failed index).
    Ready(M),
    /// Run on a blocking thread, its result taking this item's place.
    Work(Box<dyn FnOnce() -> Result<M, StreamCtrlError> + Send>),
}

impl<M> Staged<M> {
    pub fn work(f: impl FnOnce() -> Result<M, StreamCtrlError> + Send + 'static) -> Self {
        Staged::Work(Box::new(f))
    }
}

/// How many frames of one stream or burst are encoded at once.
///
/// One core is left for the capture loop and the GVSP receiver, and more than four rarely helps:
/// at a few ms per frame that is already well past what a GigE link delivers.
pub fn encode_parallelism() -> usize {
    static PARALLELISM: OnceLock<usize> = OnceLock::new();
    *PARALLELISM.get_or_init(|| {
        std::thread::available_parallelism()
            .map_or(1, |n| n.get())
            .saturating_sub(1)
            .clamp(1, 4)
    })
}

/// The items of `rx`, with their work done, in the order they arrived.
///
/// Items are taken from `rx` only while fewer than [`encode_parallelism`] are in progress, so a
/// consumer that stops polling (a slow client) leaves them waiting in the channel, where the
/// capture loop sees it full and drops frames rather than queueing them. The stream ends when
/// `rx` closes and everything taken from it has been yielded.
pub fn ordered<M: Send + 'static>(
    mut rx: Receiver<Staged<M>>,
) -> impl Stream<Item = Result<M, StreamCtrlError>> {
    futures::stream::poll_fn(move |cx| rx.poll_recv(cx))
        .map(|item| async move {
            match item {
                Staged::Ready(m) => Ok(m),
                Staged::Work(work) => tokio::task::spawn_blocking(work)
                    .await
                    .unwrap_or_else(|e| Err(StreamCtrlError::Error(format!("encoding task failed: {e}")))),
            }
        })
        .buffered(encode_parallelism())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;
    use tokio::sync::mpsc;

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn results_keep_the_order_items_arrived_in() {
        let (tx, rx) = mpsc::channel(16);
        // Earlier items take longer, so with any parallelism they finish out of order.
        for i in 0..8u64 {
            if i % 3 == 0 {
                tx.send(Staged::Ready(i)).await.unwrap();
            } else {
                tx.send(Staged::work(move || {
                    std::thread::sleep(Duration::from_millis(40 - i * 4));
                    Ok(i)
                }))
                .await
                .unwrap();
            }
        }
        drop(tx);
        let out: Vec<u64> = ordered(rx).map(Result::unwrap).collect().await;
        assert_eq!(out, (0..8).collect::<Vec<_>>());
    }

    #[tokio::test]
    async fn an_error_takes_its_items_place() {
        let (tx, rx) = mpsc::channel(4);
        tx.send(Staged::work(|| Ok(1))).await.unwrap();
        tx.send(Staged::work(|| Err(StreamCtrlError::InvalidFrame))).await.unwrap();
        tx.send(Staged::Ready(3)).await.unwrap();
        drop(tx);
        let out: Vec<_> = ordered(rx).collect().await;
        assert!(matches!(out[..], [Ok(1), Err(StreamCtrlError::InvalidFrame), Ok(3)]), "{out:?}");
    }

    #[tokio::test]
    async fn a_panicking_encoder_is_an_error_not_a_crash() {
        let (tx, rx) = mpsc::channel(1);
        tx.send(Staged::<u8>::work(|| panic!("boom"))).await.unwrap();
        drop(tx);
        let out: Vec<_> = ordered(rx).collect().await;
        assert!(matches!(out[..], [Err(StreamCtrlError::Error(_))]), "{out:?}");
    }

    #[tokio::test]
    async fn items_wait_in_the_channel_while_the_consumer_is_not_polling() {
        let (tx, rx) = mpsc::channel(2);
        let mut stream = Box::pin(ordered(rx));
        tx.send(Staged::Ready(0)).await.unwrap();
        assert_eq!(stream.next().await.unwrap().unwrap(), 0);
        // Not polled meanwhile: the channel fills up, which is what tells a capture loop to drop.
        tx.try_send(Staged::Ready(1)).unwrap();
        tx.try_send(Staged::Ready(2)).unwrap();
        assert!(tx.try_send(Staged::Ready(3)).is_err());
        assert_eq!(stream.next().await.unwrap().unwrap(), 1);
    }
}
