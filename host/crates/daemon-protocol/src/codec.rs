use serde::{de::DeserializeOwned, Serialize};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

use crate::{Error, MAX_FRAME_BYTES};

pub(crate) async fn read_json<T, R>(reader: &mut R) -> Result<T, Error>
where
    T: DeserializeOwned,
    R: AsyncRead + Unpin,
{
    let length = reader.read_u32().await.map_err(Error::Io)? as usize;
    if length == 0 {
        return Err(Error::EmptyFrame);
    }
    if length > MAX_FRAME_BYTES {
        return Err(Error::FrameTooLarge {
            actual: length,
            maximum: MAX_FRAME_BYTES,
        });
    }
    let mut payload = vec![0_u8; length];
    reader.read_exact(&mut payload).await.map_err(Error::Io)?;
    serde_json::from_slice(&payload).map_err(Error::MalformedFrame)
}

pub(crate) async fn write_json<T, W>(writer: &mut W, value: &T) -> Result<(), Error>
where
    T: Serialize,
    W: AsyncWrite + Unpin,
{
    let payload = serde_json::to_vec(value).map_err(Error::MalformedFrame)?;
    if payload.is_empty() {
        return Err(Error::EmptyFrame);
    }
    if payload.len() > MAX_FRAME_BYTES {
        return Err(Error::FrameTooLarge {
            actual: payload.len(),
            maximum: MAX_FRAME_BYTES,
        });
    }
    writer
        .write_u32(
            u32::try_from(payload.len()).map_err(|_| Error::FrameTooLarge {
                actual: payload.len(),
                maximum: MAX_FRAME_BYTES,
            })?,
        )
        .await
        .map_err(Error::Io)?;
    writer.write_all(&payload).await.map_err(Error::Io)?;
    writer.flush().await.map_err(Error::Io)
}
