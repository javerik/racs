use std::time::Duration;

use futures_util::{Stream, StreamExt};
use tokio::net::TcpStream;
use tokio_tungstenite::tungstenite::{self, Message};
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream};
use url::Url;

use crate::client::RacsClient;
use crate::error::{Error, Result};
use crate::frame::Frame;
use crate::models::StreamInfo;

/// Bytes of `[u32 LE frame_number][u32 LE frames_dropped]` in front of every frame message.
const FRAME_HEADER_LEN: usize = 8;

/// How long [`LiveStream::close`] waits for the server to confirm.
const CLOSE_TIMEOUT: Duration = Duration::from_secs(5);

/// Splits a binary live-stream message into `(frame_number, dropped, image)`.
pub(crate) fn parse_frame_message(message: &[u8]) -> Result<(u32, u32, Vec<u8>)> {
    if message.len() < FRAME_HEADER_LEN {
        return Err(Error::Protocol(format!("frame message of {} bytes is shorter than its header", message.len())));
    }
    let frame_number = u32::from_le_bytes(message[0..4].try_into().expect("4 bytes"));
    let dropped = u32::from_le_bytes(message[4..8].try_into().expect("4 bytes"));
    Ok((frame_number, dropped, message[FRAME_HEADER_LEN..].to_vec()))
}

pub(crate) type Socket = WebSocketStream<MaybeTlsStream<TcpStream>>;

/// Opens a WebSocket. A refused upgrade becomes the matching [`Error`], with the response body or,
/// when it has none, what `reason` reads (not for a `401`, whose body says enough).
pub(crate) async fn open_socket<F, Fut>(url: &Url, reason: F) -> Result<Socket>
where
    F: FnOnce() -> Fut,
    Fut: std::future::Future<Output = Result<String>>,
{
    match tokio_tungstenite::connect_async(url.as_str()).await {
        Ok((socket, _)) => Ok(socket),
        Err(tungstenite::Error::Http(response)) => {
            let status = response.status().as_u16();
            let body = response
                .body()
                .as_deref()
                .map(|b| String::from_utf8_lossy(b).into_owned())
                .filter(|b| !b.is_empty());
            let body = match body {
                Some(body) => body,
                None if status == 401 => String::new(),
                None => reason().await?,
            };
            Err(Error::from_response(status, body, without_session(url)))
        }
        Err(e) => Err(e.into()),
    }
}

/// The URL without its `session` parameter, for error messages: the session id is a secret.
fn without_session(url: &Url) -> String {
    let mut url = url.clone();
    let pairs: Vec<(String, String)> =
        url.query_pairs().filter(|(k, _)| k != "session").map(|(k, v)| (k.into_owned(), v.into_owned())).collect();
    if pairs.is_empty() {
        url.set_query(None);
    } else {
        url.query_pairs_mut().clear().extend_pairs(pairs);
    }
    url.to_string()
}

/// A running live stream.
///
/// Read it with [`next_frame`](Self::next_frame) or turn it into a `Stream` with
/// [`into_frames`](Self::into_frames). The camera is held until the stream is closed or dropped:
/// GenICam reads and writes still work meanwhile, frame grabs and burst jobs fail as busy.
/// [`close`](Self::close) releases the camera cleanly; dropping the stream releases it too, as
/// the server notices the lost connection.
pub struct LiveStream {
    socket: Socket,
    device_id: u32,
    info: Option<StreamInfo>,
    closed: bool,
    receive_timeout: Duration,
}

impl std::fmt::Debug for LiveStream {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("LiveStream")
            .field("device_id", &self.device_id)
            .field("info", &self.info)
            .field("closed", &self.closed)
            .finish()
    }
}

impl LiveStream {
    pub(crate) async fn connect(client: &RacsClient, device_id: u32, url: Url, receive_timeout: Duration) -> Result<Self> {
        let socket = open_socket(&url, || async {
            // The server records why an upgrade was refused.
            Ok(client.get_stream_error(device_id).await?.last_error.unwrap_or_default())
        })
        .await?;
        Ok(Self { socket, device_id, info: None, closed: false, receive_timeout })
    }

    pub fn device_id(&self) -> u32 {
        self.device_id
    }

    /// Describes the frames being received. Replaced whenever the geometry changes mid-stream.
    pub fn info(&self) -> Option<&StreamInfo> {
        self.info.as_ref()
    }

    pub fn is_closed(&self) -> bool {
        self.closed
    }

    /// The next frame, or `None` once the stream has ended. [`Error::LiveStream`] for a stream
    /// the server ended because of an error, [`Error::SessionEnded`] (`4001`) when this client's
    /// session ended, [`Error::AccessRevoked`] (`4003`) when another session took the device with
    /// `force`; [`Error::Timeout`] when nothing arrives within the receive timeout (the stream
    /// stays usable).
    pub async fn next_frame(&mut self) -> Result<Option<Frame>> {
        while !self.closed {
            let message = match tokio::time::timeout(self.receive_timeout, self.socket.next()).await {
                Err(_) => {
                    return Err(Error::Timeout(format!(
                        "no message from device {} within {:?}",
                        self.device_id, self.receive_timeout
                    )))
                }
                Ok(None) => {
                    self.closed = true;
                    return Err(Error::LiveStream { reason: "connection closed without a close frame".into(), code: None });
                }
                Ok(Some(Err(e))) => {
                    self.closed = true;
                    return Err(e.into());
                }
                Ok(Some(Ok(message))) => message,
            };

            match message {
                Message::Text(text) => self.info = Some(serde_json::from_str(text.as_str())?),
                Message::Binary(data) => {
                    let info = self
                        .info
                        .as_ref()
                        .ok_or_else(|| Error::Protocol("frame received before the stream info".into()))?;
                    let (frame_number, dropped, image) = parse_frame_message(&data)?;
                    return Ok(Some(Frame {
                        data: image,
                        width: info.width,
                        height: info.height,
                        format: info.format,
                        pixel_format: info.pixel_format.clone(),
                        bit_depth: info.bit_depth,
                        frame_number: Some(frame_number),
                        dropped: Some(dropped),
                    }));
                }
                Message::Close(frame) => {
                    self.closed = true;
                    // Completes the closing handshake.
                    let _ = self.socket.close(None).await;
                    if let Some(error) = frame.and_then(|f| Error::from_close(u16::from(f.code), &f.reason)) {
                        return Err(error);
                    }
                }
                // Pings are answered by the socket itself.
                _ => {}
            }
        }
        Ok(None)
    }

    /// The frames as a `Stream`, ending after the last frame or the first error.
    pub fn into_frames(self) -> impl Stream<Item = Result<Frame>> {
        futures_util::stream::unfold(Some(self), |state| async move {
            let mut stream = state?;
            match stream.next_frame().await {
                Ok(Some(frame)) => Some((Ok(frame), Some(stream))),
                Ok(None) => None,
                Err(e) => Some((Err(e), None)),
            }
        })
    }

    /// Stops the stream and waits (up to 5 s) until the server has released the camera.
    pub async fn close(mut self) -> Result<()> {
        if self.closed {
            return Ok(());
        }
        self.closed = true;
        self.socket.close(None).await?;
        // The server confirms once its capture loop has stopped; frames sent before that are discarded.
        let drain = async { while let Some(Ok(_)) = self.socket.next().await {} };
        let _ = tokio::time::timeout(CLOSE_TIMEOUT, drain).await;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_frame_message_is_two_le_counters_then_the_image() {
        let message = [1, 0, 0, 0, 2, 1, 0, 0, 0xAA, 0xBB];
        assert_eq!(parse_frame_message(&message).unwrap(), (1, 258, vec![0xAA, 0xBB]));
        assert!(parse_frame_message(&[0, 1, 2]).is_err());
    }
}
