use anyhow::{anyhow, Result};
use async_channel::Receiver;
use bytes::Bytes;
use std::sync::Arc;
use wacore::net::{Transport, TransportEvent, TransportFactory, WHATSAPP_WEB_WS_URL};
use wasm_bindgen::{closure::Closure, JsCast};
use web_sys::{BinaryType, CloseEvent, Event, MessageEvent, WebSocket};

#[derive(Debug, Clone, Copy, Default)]
pub struct WorkerWebSocketTransportFactory;

unsafe impl Send for WorkerWebSocketTransportFactory {}
unsafe impl Sync for WorkerWebSocketTransportFactory {}

#[cfg_attr(target_arch = "wasm32", async_trait::async_trait(?Send))]
#[cfg_attr(not(target_arch = "wasm32"), async_trait::async_trait)]
impl TransportFactory for WorkerWebSocketTransportFactory {
    async fn create_transport(&self) -> Result<(Arc<dyn Transport>, Receiver<TransportEvent>)> {
        let socket = WebSocket::new(WHATSAPP_WEB_WS_URL)
            .map_err(|error| anyhow!("failed to open WhatsApp websocket: {error:?}"))?;
        socket.set_binary_type(BinaryType::Arraybuffer);

        let (tx, rx) = async_channel::bounded::<TransportEvent>(1024);

        let open_tx = tx.clone();
        let onopen = Closure::<dyn FnMut(Event)>::new(move |_| {
            let _ = open_tx.try_send(TransportEvent::Connected);
        });
        socket.set_onopen(Some(onopen.as_ref().unchecked_ref()));

        let message_tx = tx.clone();
        let onmessage = Closure::<dyn FnMut(MessageEvent)>::new(move |event: MessageEvent| {
            if let Some(bytes) = message_bytes(event.data()) {
                let _ = message_tx.try_send(TransportEvent::DataReceived(Bytes::from(bytes)));
            }
        });
        socket.set_onmessage(Some(onmessage.as_ref().unchecked_ref()));

        let close_tx = tx.clone();
        let onclose = Closure::<dyn FnMut(CloseEvent)>::new(move |_| {
            let _ = close_tx.try_send(TransportEvent::Disconnected);
        });
        socket.set_onclose(Some(onclose.as_ref().unchecked_ref()));

        let error_tx = tx;
        let onerror = Closure::<dyn FnMut(Event)>::new(move |_| {
            let _ = error_tx.try_send(TransportEvent::Disconnected);
        });
        socket.set_onerror(Some(onerror.as_ref().unchecked_ref()));

        Ok((
            Arc::new(WorkerWebSocketTransport {
                socket,
                _onopen: onopen,
                _onmessage: onmessage,
                _onclose: onclose,
                _onerror: onerror,
            }),
            rx,
        ))
    }
}

struct WorkerWebSocketTransport {
    socket: WebSocket,
    _onopen: Closure<dyn FnMut(Event)>,
    _onmessage: Closure<dyn FnMut(MessageEvent)>,
    _onclose: Closure<dyn FnMut(CloseEvent)>,
    _onerror: Closure<dyn FnMut(Event)>,
}

unsafe impl Send for WorkerWebSocketTransport {}
unsafe impl Sync for WorkerWebSocketTransport {}

#[cfg_attr(target_arch = "wasm32", async_trait::async_trait(?Send))]
#[cfg_attr(not(target_arch = "wasm32"), async_trait::async_trait)]
impl Transport for WorkerWebSocketTransport {
    async fn send(&self, data: Bytes) -> Result<()> {
        self.socket
            .send_with_u8_array(&data)
            .map_err(|error| anyhow!("websocket send failed: {error:?}"))
    }

    async fn disconnect(&self) {
        let _ = self.socket.close();
    }
}

fn message_bytes(data: wasm_bindgen::JsValue) -> Option<Vec<u8>> {
    if data.is_instance_of::<js_sys::ArrayBuffer>() || data.is_instance_of::<js_sys::Uint8Array>() {
        return Some(js_sys::Uint8Array::new(&data).to_vec());
    }
    data.as_string().map(String::into_bytes)
}
