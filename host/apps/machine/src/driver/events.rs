use std::collections::VecDeque;
use std::future::Future;
use std::sync::{Arc, Mutex};

use gateway_client::protocol::DeviceExecEventParams;
use tracing::{error, warn};

pub(crate) const MAX_DEVICE_EXEC_EVENT_OUTBOX: usize = 2048;

pub(crate) fn exec_event_outbox_len(outbox: &Arc<Mutex<VecDeque<DeviceExecEventParams>>>) -> usize {
    outbox.lock().map(|queue| queue.len()).unwrap_or(0)
}

pub(crate) enum ExecEventSendOutcome {
    Sent,
    Retry(String),
    Drop(String),
}

pub(crate) fn queue_exec_event_for_retry(
    outbox: &Arc<Mutex<VecDeque<DeviceExecEventParams>>>,
    event: DeviceExecEventParams,
) {
    let mut queue = match outbox.lock() {
        Ok(queue) => queue,
        Err(error) => {
            error!(event = "device.exec.event.outbox_lock_failed", error = %error);
            return;
        }
    };

    if queue.len() >= MAX_DEVICE_EXEC_EVENT_OUTBOX {
        if let Some(dropped) = queue.pop_front() {
            warn!(
                event = "device.exec.event.outbox_drop_oldest",
                event_id = %dropped.event_id,
                session_id = %dropped.session_id,
                exec_event = %dropped.event,
                max_outbox = MAX_DEVICE_EXEC_EVENT_OUTBOX,
            );
        }
    }

    queue.push_back(event);
}

pub(crate) async fn flush_exec_event_outbox_with_sender<F, Fut>(
    outbox: &Arc<Mutex<VecDeque<DeviceExecEventParams>>>,
    mut send_event: F,
) -> usize
where
    F: FnMut(DeviceExecEventParams) -> Fut,
    Fut: Future<Output = ExecEventSendOutcome>,
{
    let mut sent = 0usize;

    loop {
        let next_event = match outbox.lock() {
            Ok(queue) => queue.front().cloned(),
            Err(error) => {
                error!(event = "device.exec.event.outbox_lock_failed", error = %error);
                return sent;
            }
        };

        let Some(event) = next_event else {
            return sent;
        };

        match send_event(event.clone()).await {
            ExecEventSendOutcome::Sent => {
                if let Ok(mut queue) = outbox.lock() {
                    let _ = queue.pop_front();
                }
                sent += 1;
            }
            ExecEventSendOutcome::Drop(error) => {
                error!(
                    event = "device.exec.event.serialize_failed",
                    event_id = %event.event_id,
                    session_id = %event.session_id,
                    exec_event = %event.event,
                    error = %error,
                );
                if let Ok(mut queue) = outbox.lock() {
                    let _ = queue.pop_front();
                }
                continue;
            }
            ExecEventSendOutcome::Retry(error) => {
                warn!(
                    event = "device.exec.event.send_failed",
                    event_id = %event.event_id,
                    session_id = %event.session_id,
                    exec_event = %event.event,
                    error = %error,
                    outbox_depth = exec_event_outbox_len(outbox),
                );
                return sent;
            }
        }
    }
}
