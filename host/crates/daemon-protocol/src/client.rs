use std::time::Duration;

use crate::{
    codec,
    protocol::{Outcome, Request, Response},
    transport, Command, DaemonControlEndpoint, DaemonStatus, Diagnostics, Error, Success,
    TimeoutStage, PROTOCOL_VERSION,
};

#[derive(Clone, Debug)]
pub struct ClientOptions {
    connect_timeout: Duration,
    io_timeout: Duration,
}

impl ClientOptions {
    #[must_use]
    pub fn with_connect_timeout(mut self, value: Duration) -> Self {
        self.connect_timeout = value;
        self
    }

    #[must_use]
    pub fn with_io_timeout(mut self, value: Duration) -> Self {
        self.io_timeout = value;
        self
    }
}

impl Default for ClientOptions {
    fn default() -> Self {
        Self {
            connect_timeout: Duration::from_secs(2),
            io_timeout: Duration::from_secs(5),
        }
    }
}

#[derive(Clone, Debug)]
pub struct DaemonControlClient {
    endpoint: DaemonControlEndpoint,
    options: ClientOptions,
}

impl DaemonControlClient {
    #[must_use]
    pub fn new(endpoint: DaemonControlEndpoint, options: ClientOptions) -> Self {
        Self { endpoint, options }
    }

    pub async fn status(&self) -> Result<DaemonStatus, Error> {
        match self.request(Command::Status).await? {
            Success::Status { status } => Ok(status),
            _ => Err(Error::UnexpectedResponse),
        }
    }

    pub async fn reload(&self) -> Result<(), Error> {
        match self.request(Command::Reload).await? {
            Success::ReloadAccepted => Ok(()),
            _ => Err(Error::UnexpectedResponse),
        }
    }

    pub async fn reconnect(&self) -> Result<(), Error> {
        match self.request(Command::Reconnect).await? {
            Success::ReconnectAccepted => Ok(()),
            _ => Err(Error::UnexpectedResponse),
        }
    }

    pub async fn diagnostics(&self) -> Result<Diagnostics, Error> {
        match self.request(Command::Diagnostics).await? {
            Success::Diagnostics { diagnostics } => Ok(diagnostics),
            _ => Err(Error::UnexpectedResponse),
        }
    }

    pub async fn shutdown(&self) -> Result<(), Error> {
        match self.request(Command::Shutdown).await? {
            Success::ShutdownAccepted => Ok(()),
            _ => Err(Error::UnexpectedResponse),
        }
    }

    async fn request(&self, command: Command) -> Result<Success, Error> {
        let mut stream = transport::connect(&self.endpoint, self.options.connect_timeout).await?;
        let request = Request::new(command);
        timeout(
            self.options.io_timeout,
            TimeoutStage::Write,
            codec::write_json(&mut stream, &request),
        )
        .await?;
        let response: Response = timeout(
            self.options.io_timeout,
            TimeoutStage::Read,
            codec::read_json(&mut stream),
        )
        .await?;
        if response.protocol_version != PROTOCOL_VERSION {
            return Err(Error::UnsupportedVersion {
                actual: response.protocol_version,
                expected: PROTOCOL_VERSION,
            });
        }
        if response.request_id != request.request_id {
            return Err(Error::UnexpectedResponse);
        }
        match response.outcome {
            Outcome::Success { response } => Ok(response),
            Outcome::Error { code } => Err(Error::Remote(code)),
        }
    }
}

async fn timeout<T>(
    duration: Duration,
    stage: TimeoutStage,
    future: impl Future<Output = Result<T, Error>>,
) -> Result<T, Error> {
    tokio::time::timeout(duration, future)
        .await
        .map_err(|_| Error::Timeout { stage, duration })?
}

use std::future::Future;
