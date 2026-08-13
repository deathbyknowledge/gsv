use std::time::Duration;

use crate::{
    codec,
    protocol::{Outcome, Request, Response},
    transport, Command, DesktopControlEndpoint, DesktopStatus, Error, ProcessId, Success,
    TimeoutStage, PROTOCOL_VERSION,
};

#[derive(Clone, Debug)]
pub struct ClientOptions {
    connect_timeout: Duration,
    write_timeout: Duration,
    response_timeout: Duration,
}

impl ClientOptions {
    #[must_use]
    pub fn with_connect_timeout(mut self, value: Duration) -> Self {
        self.connect_timeout = value;
        self
    }

    #[must_use]
    pub fn with_io_timeout(mut self, value: Duration) -> Self {
        self.write_timeout = value;
        self.response_timeout = value;
        self
    }

    /// Sets how long the client waits for Desktop's response after writing.
    ///
    /// This should exceed the server's operation timeout so a mutating command
    /// cannot succeed after the caller has already reported a local timeout.
    #[must_use]
    pub fn with_response_timeout(mut self, value: Duration) -> Self {
        self.response_timeout = value;
        self
    }
}

impl Default for ClientOptions {
    fn default() -> Self {
        Self {
            connect_timeout: Duration::from_secs(2),
            write_timeout: Duration::from_secs(3),
            response_timeout: Duration::from_secs(12),
        }
    }
}

#[derive(Clone, Debug)]
pub struct DesktopControlClient {
    endpoint: DesktopControlEndpoint,
    options: ClientOptions,
}

impl DesktopControlClient {
    #[must_use]
    pub fn new(endpoint: DesktopControlEndpoint, options: ClientOptions) -> Self {
        Self { endpoint, options }
    }

    pub async fn activate(&self) -> Result<(), Error> {
        match self.request(Command::Activate).await? {
            Success::Activated => Ok(()),
            _ => Err(Error::UnexpectedResponse),
        }
    }

    pub async fn status(&self) -> Result<DesktopStatus, Error> {
        match self.request(Command::Status).await? {
            Success::Status { status } => Ok(status),
            _ => Err(Error::UnexpectedResponse),
        }
    }

    pub async fn new_conversation(&self) -> Result<ProcessId, Error> {
        match self.request(Command::New).await? {
            Success::Created { process_id } => Ok(process_id),
            _ => Err(Error::UnexpectedResponse),
        }
    }

    pub async fn use_process(&self, process_id: ProcessId) -> Result<ProcessId, Error> {
        match self.request(Command::Use { process_id }).await? {
            Success::Selected { process_id } => Ok(process_id),
            _ => Err(Error::UnexpectedResponse),
        }
    }

    async fn request(&self, command: Command) -> Result<Success, Error> {
        let mut stream = transport::connect(&self.endpoint, self.options.connect_timeout).await?;
        let request = Request::new(command);

        tokio::time::timeout(
            self.options.write_timeout,
            codec::write_json(&mut stream, &request),
        )
        .await
        .map_err(|_| Error::Timeout {
            stage: TimeoutStage::Write,
            duration: self.options.write_timeout,
        })??;

        let response: Response =
            tokio::time::timeout(self.options.response_timeout, codec::read_json(&mut stream))
                .await
                .map_err(|_| Error::Timeout {
                    stage: TimeoutStage::Read,
                    duration: self.options.response_timeout,
                })??;
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
