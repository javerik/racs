use std::pin::Pin;
use std::task::{Context, Poll};

use futures_util::{Stream, StreamExt};
use tokio_tungstenite::tungstenite::Message;
use url::Url;

use crate::error::{Error, Result};
use crate::live::{open_socket, Socket};
use crate::models::Event;

/// The events socket: a `Stream` of [`Event`]s, from [`RacsClient::events`](crate::RacsClient::events).
///
/// The first event is [`EventKind::Hello`](crate::models::EventKind::Hello) with the state of every
/// connected device. The stream ends when the server closes the socket, with
/// [`Error::SessionEnded`] if the client's session ended. Read it steadily: the server pings the
/// socket, and the pongs (sent while it is read) keep the session alive.
///
/// ```no_run
/// use futures_util::StreamExt;
/// use racs_client::models::EventKind;
///
/// # async fn demo() -> racs_client::Result<()> {
/// let client = racs_client::RacsClient::new("http://localhost:8742")?;
/// let mut events = client.events().await?;
/// while let Some(event) = events.next().await {
///     if let EventKind::FeatureChanged { device, feature, by } = event?.kind {
///         println!("{feature} on device {device} changed by {by:?}");
///     }
/// }
/// # Ok(()) }
/// ```
pub struct EventStream {
    socket: Socket,
    done: bool,
}

impl std::fmt::Debug for EventStream {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("EventStream").field("done", &self.done).finish()
    }
}

impl EventStream {
    pub(crate) async fn connect(url: Url) -> Result<Self> {
        let socket = open_socket(&url, || async { Ok(String::new()) }).await?;
        Ok(Self { socket, done: false })
    }

    /// The next event, or `None` once the socket has closed.
    pub async fn next_event(&mut self) -> Result<Option<Event>> {
        self.next().await.transpose()
    }

    /// Closes the socket.
    pub async fn close(mut self) -> Result<()> {
        if self.done {
            return Ok(());
        }
        self.done = true;
        self.socket.close(None).await?;
        Ok(())
    }
}

impl Stream for EventStream {
    type Item = Result<Event>;

    fn poll_next(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        loop {
            if self.done {
                return Poll::Ready(None);
            }
            let message = match self.socket.poll_next_unpin(cx) {
                Poll::Pending => return Poll::Pending,
                Poll::Ready(None) => {
                    self.done = true;
                    return Poll::Ready(None);
                }
                Poll::Ready(Some(Err(e))) => {
                    self.done = true;
                    return Poll::Ready(Some(Err(e.into())));
                }
                Poll::Ready(Some(Ok(message))) => message,
            };
            match message {
                Message::Text(text) => {
                    return Poll::Ready(Some(serde_json::from_str(text.as_str()).map_err(Error::from)));
                }
                Message::Close(frame) => {
                    // The socket answers the close itself.
                    self.done = true;
                    let error = frame.and_then(|f| Error::from_close(u16::from(f.code), &f.reason));
                    return Poll::Ready(error.map(Err));
                }
                // Pings are answered by the socket itself.
                _ => {}
            }
        }
    }
}
