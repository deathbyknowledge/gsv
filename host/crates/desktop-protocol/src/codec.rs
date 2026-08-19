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

#[cfg(test)]
mod tests {
    use serde::{Deserialize, Serialize};
    use tokio::io::{duplex, AsyncWriteExt};

    use super::*;
    use crate::{protocol::Request, Command, MicrophoneName, PROTOCOL_VERSION};

    #[derive(Debug, Eq, PartialEq, Serialize, Deserialize)]
    struct Example {
        value: String,
    }

    #[tokio::test]
    async fn round_trips_a_length_prefixed_json_frame() {
        let (mut sender, mut receiver) = duplex(1024);
        let expected = Example {
            value: "hello".to_string(),
        };

        write_json(&mut sender, &expected)
            .await
            .expect("frame writes");
        let actual: Example = read_json(&mut receiver).await.expect("frame reads");

        assert_eq!(actual, expected);
    }

    #[tokio::test]
    async fn rejects_an_oversized_frame_before_allocating_its_body() {
        let (mut sender, mut receiver) = duplex(16);
        sender
            .write_u32((MAX_FRAME_BYTES + 1) as u32)
            .await
            .expect("header writes");

        assert!(matches!(
            read_json::<Example, _>(&mut receiver).await,
            Err(Error::FrameTooLarge {
                actual,
                maximum: MAX_FRAME_BYTES
            }) if actual == MAX_FRAME_BYTES + 1
        ));
    }

    #[tokio::test]
    async fn rejects_empty_and_malformed_frames() {
        let (mut empty_sender, mut empty_receiver) = duplex(16);
        empty_sender.write_u32(0).await.expect("header writes");
        assert!(matches!(
            read_json::<Example, _>(&mut empty_receiver).await,
            Err(Error::EmptyFrame)
        ));

        let (mut bad_sender, mut bad_receiver) = duplex(16);
        bad_sender.write_u32(1).await.expect("header writes");
        bad_sender.write_all(b"{").await.expect("body writes");
        assert!(matches!(
            read_json::<Example, _>(&mut bad_receiver).await,
            Err(Error::MalformedFrame(_))
        ));
    }

    #[tokio::test]
    async fn microphone_request_round_trips_through_the_codec() {
        let (mut sender, mut receiver) = duplex(1024);
        let expected = Request::new(Command::MicrophoneUse {
            name: MicrophoneName::new("Shure MV6").expect("valid microphone name"),
        });

        write_json(&mut sender, &expected)
            .await
            .expect("request writes");
        let actual: Request = read_json(&mut receiver).await.expect("request reads");

        assert_eq!(actual, expected);
    }

    #[tokio::test]
    async fn microphone_request_codec_rejects_extra_fields() {
        let (mut sender, mut receiver) = duplex(1024);
        let request = serde_json::to_vec(&serde_json::json!({
            "protocolVersion": PROTOCOL_VERSION,
            "requestId": uuid::Uuid::new_v4(),
            "command": {
                "type": "microphoneUse",
                "name": "Shure MV6",
                "deviceId": "private-system-id"
            }
        }))
        .expect("request serializes");
        sender
            .write_u32(request.len() as u32)
            .await
            .expect("header writes");
        sender.write_all(&request).await.expect("body writes");

        assert!(matches!(
            read_json::<Request, _>(&mut receiver).await,
            Err(Error::MalformedFrame(_))
        ));
    }
}
