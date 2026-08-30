use std::collections::HashSet;
use std::fmt::{Display, Formatter};

use capnp::message::{Builder, HeapAllocator, ReaderOptions};
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use serde_json::{Map, Number, Value};

#[rustfmt::skip]
pub mod wire_frame_capnp;
#[rustfmt::skip]
pub mod wire_frame_v0_capnp;

pub const MAX_CONTROL_FRAME_BYTES: usize = 1024 * 1024;
pub const MAX_CONTROL_SEGMENTS: usize = 16;
pub const MAX_CONTROL_NESTING: usize = 64;
pub const MAX_CONTROL_NODES: usize = 65_536;
pub const V4_BINARY_HEADER_BYTES: usize = 5;
pub const V4_CONTROL_STREAM_ID: u32 = 0;
pub const V4_CONTROL_UNPACKED: u8 = 0;
pub const V4_CONTROL_PACKED: u8 = 1;
const MAX_SAFE_INTEGER_U64: u64 = 9_007_199_254_740_991;
const INITIAL_SEGMENT_WORDS: u32 = 256;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum ControlFrame {
    #[serde(rename = "req")]
    Request {
        id: String,
        call: String,
        args: Value,
        #[serde(rename = "runId", skip_serializing_if = "Option::is_none")]
        run_id: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        body: Option<BodyDescriptor>,
    },
    #[serde(rename = "res")]
    Response {
        id: String,
        ok: bool,
        #[serde(default, skip_serializing_if = "OptionalJson::is_absent")]
        data: OptionalJson,
        #[serde(skip_serializing_if = "Option::is_none")]
        body: Option<BodyDescriptor>,
        #[serde(skip_serializing_if = "Option::is_none")]
        error: Option<WireError>,
    },
    #[serde(rename = "sig")]
    Signal {
        signal: String,
        #[serde(default, skip_serializing_if = "OptionalJson::is_absent")]
        payload: OptionalJson,
        #[serde(skip_serializing_if = "Option::is_none")]
        seq: Option<f64>,
    },
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct BodyDescriptor {
    #[serde(rename = "streamId")]
    pub stream_id: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub length: Option<u64>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct WireError {
    pub code: f64,
    pub message: String,
    #[serde(default, skip_serializing_if = "OptionalJson::is_absent")]
    pub details: OptionalJson,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub retryable: Option<bool>,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub enum OptionalJson {
    #[default]
    Absent,
    Present(Value),
}

impl OptionalJson {
    pub fn is_absent(&self) -> bool {
        matches!(self, Self::Absent)
    }
}

impl Serialize for OptionalJson {
    fn serialize<S>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        match self {
            Self::Absent => serializer.serialize_unit(),
            Self::Present(value) => value.serialize(serializer),
        }
    }
}

impl<'de> Deserialize<'de> for OptionalJson {
    fn deserialize<D>(deserializer: D) -> std::result::Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        Ok(Self::Present(Value::deserialize(deserializer)?))
    }
}

#[derive(Debug)]
pub struct InvalidControlFrame(String);

impl InvalidControlFrame {
    fn new(message: impl Into<String>) -> Self {
        Self(message.into())
    }
}

impl Display for InvalidControlFrame {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl std::error::Error for InvalidControlFrame {}

impl From<capnp::Error> for InvalidControlFrame {
    fn from(error: capnp::Error) -> Self {
        Self::new(error.to_string())
    }
}

impl From<capnp::NotInSchema> for InvalidControlFrame {
    fn from(error: capnp::NotInSchema) -> Self {
        Self::new(format!("unknown schema discriminant {}", error.0))
    }
}

pub type Result<T> = std::result::Result<T, InvalidControlFrame>;

pub fn encode_control_frame(frame: &ControlFrame, packed: bool) -> Result<Vec<u8>> {
    serialize_message(&build_message(frame)?, packed, Vec::new(), 0)
}

pub fn encode_v4_control_message(frame: &ControlFrame, packed: bool) -> Result<Vec<u8>> {
    let mut output = Vec::with_capacity(V4_BINARY_HEADER_BYTES);
    output.extend_from_slice(&V4_CONTROL_STREAM_ID.to_le_bytes());
    output.push(if packed {
        V4_CONTROL_PACKED
    } else {
        V4_CONTROL_UNPACKED
    });
    serialize_message(
        &build_message(frame)?,
        packed,
        output,
        V4_BINARY_HEADER_BYTES,
    )
}

#[derive(Debug, PartialEq)]
pub enum V4BinaryMessage<'a> {
    Control {
        frame: ControlFrame,
        packed: bool,
    },
    Body {
        stream_id: u32,
        flags: u8,
        payload: &'a [u8],
    },
}

pub fn decode_v4_binary_message(source: &[u8]) -> Result<V4BinaryMessage<'_>> {
    if source.len() < V4_BINARY_HEADER_BYTES {
        return Err(InvalidControlFrame::new("truncated v4 binary header"));
    }
    let stream_id = u32::from_le_bytes(
        source[..4]
            .try_into()
            .expect("v4 binary header length checked"),
    );
    let flags = source[4];
    let payload = &source[V4_BINARY_HEADER_BYTES..];
    if stream_id != V4_CONTROL_STREAM_ID {
        return Ok(V4BinaryMessage::Body {
            stream_id,
            flags,
            payload,
        });
    }
    let packed = match flags {
        V4_CONTROL_UNPACKED => false,
        V4_CONTROL_PACKED => true,
        _ => return Err(InvalidControlFrame::new("unknown v4 control encoding")),
    };
    Ok(V4BinaryMessage::Control {
        frame: decode_control_frame(payload, packed)?,
        packed,
    })
}

fn build_message(frame: &ControlFrame) -> Result<Builder<HeapAllocator>> {
    let mut message = Builder::new(HeapAllocator::new().first_segment_words(INITIAL_SEGMENT_WORDS));
    let mut budget = Budget::new();
    {
        let root = message.init_root::<wire_frame_capnp::wire_frame::Builder<'_>>();
        match frame {
            ControlFrame::Request {
                id,
                call,
                args,
                run_id,
                body,
            } => {
                let mut request = root.init_request();
                request.set_id(id.as_str());
                request.set_call(call.as_str());
                write_json(args, request.reborrow().init_args(), &mut budget, 0)?;
                if let Some(run_id) = run_id {
                    request.set_run_id(run_id.as_str());
                }
                if let Some(body) = body {
                    write_body(body, request.reborrow().init_body())?;
                }
            }
            ControlFrame::Response {
                id,
                ok,
                data,
                body,
                error,
            } => {
                let mut response = root.init_response();
                response.set_id(id.as_str());
                if *ok {
                    if error.is_some() {
                        return Err(InvalidControlFrame::new(
                            "successful response cannot contain an error",
                        ));
                    }
                    let mut success = response.init_success();
                    if let OptionalJson::Present(data) = data {
                        write_json(data, success.reborrow().init_data(), &mut budget, 0)?;
                    }
                    if let Some(body) = body {
                        write_body(body, success.reborrow().init_body())?;
                    }
                } else {
                    if !data.is_absent() || body.is_some() {
                        return Err(InvalidControlFrame::new(
                            "failed response cannot contain data or a body",
                        ));
                    }
                    let error = error.as_ref().ok_or_else(|| {
                        InvalidControlFrame::new("failed response requires an error")
                    })?;
                    let failure = response.init_failure();
                    write_error(error, failure.init_error(), &mut budget)?;
                }
            }
            ControlFrame::Signal {
                signal,
                payload,
                seq,
            } => {
                let mut target = root.init_signal();
                target.set_signal(signal.as_str());
                if let OptionalJson::Present(payload) = payload {
                    write_json(payload, target.reborrow().init_payload(), &mut budget, 0)?;
                }
                if let Some(seq) = seq {
                    finite(*seq, "signal sequence")?;
                    target.get_seq().set_value(*seq);
                }
            }
        }
    }

    Ok(message)
}

fn serialize_message(
    message: &Builder<HeapAllocator>,
    packed: bool,
    mut output: Vec<u8>,
    prefix_bytes: usize,
) -> Result<Vec<u8>> {
    if packed {
        capnp::serialize_packed::write_message(&mut output, message)?;
    } else {
        capnp::serialize::write_message(&mut output, message)?;
    }
    if output.len() - prefix_bytes > MAX_CONTROL_FRAME_BYTES {
        return Err(InvalidControlFrame::new(
            "encoded control frame exceeds byte limit",
        ));
    }
    Ok(output)
}

pub fn decode_control_frame(source: &[u8], packed: bool) -> Result<ControlFrame> {
    if source.len() > MAX_CONTROL_FRAME_BYTES {
        return Err(InvalidControlFrame::new("control frame exceeds byte limit"));
    }
    let unpacked;
    let source = if packed {
        unpacked = unpack_bounded(source, MAX_CONTROL_FRAME_BYTES)?;
        unpacked.as_slice()
    } else {
        source
    };
    validate_unpacked(source)?;

    let options = ReaderOptions {
        traversal_limit_in_words: Some(MAX_CONTROL_FRAME_BYTES / 8),
        nesting_limit: MAX_CONTROL_NESTING as i32,
    };
    let mut remaining = source;
    let message = capnp::serialize::read_message_from_flat_slice(&mut remaining, options)?;
    if !remaining.is_empty() {
        return Err(InvalidControlFrame::new(
            "trailing bytes after control frame",
        ));
    }
    let root = message.get_root::<wire_frame_capnp::wire_frame::Reader<'_>>()?;
    read_frame(root, &mut Budget::new())
}

fn write_error(
    error: &WireError,
    mut target: wire_frame_capnp::wire_error::Builder<'_>,
    budget: &mut Budget,
) -> Result<()> {
    finite(error.code, "error code")?;
    target.set_code(error.code);
    target.set_message(error.message.as_str());
    if let OptionalJson::Present(details) = &error.details {
        write_json(details, target.reborrow().init_details(), budget, 0)?;
    }
    if let Some(retryable) = error.retryable {
        target.get_retryable().set_value(retryable);
    }
    Ok(())
}

fn write_body(
    body: &BodyDescriptor,
    mut target: wire_frame_capnp::body_descriptor::Builder<'_>,
) -> Result<()> {
    if body.stream_id == 0 {
        return Err(InvalidControlFrame::new("invalid body stream id"));
    }
    target.set_stream_id(body.stream_id);
    if let Some(length) = body.length {
        if length > MAX_SAFE_INTEGER_U64 {
            return Err(InvalidControlFrame::new("body length exceeds JSON range"));
        }
        target.get_length().set_value(length);
    }
    Ok(())
}

fn write_json(
    value: &Value,
    mut target: wire_frame_capnp::json_value::Builder<'_>,
    budget: &mut Budget,
    depth: usize,
) -> Result<()> {
    budget.consume(depth)?;
    match value {
        Value::Null => target.set_null_value(()),
        Value::Bool(value) => target.set_bool_value(*value),
        Value::Number(value) => target.set_number_value(json_number(value)?),
        Value::String(value) => target.set_string_value(value.as_str()),
        Value::Array(values) => {
            let length = u32::try_from(values.len())
                .map_err(|_| InvalidControlFrame::new("JSON array is too large"))?;
            let mut list = target.init_array_value(length);
            for (index, value) in values.iter().enumerate() {
                write_json(value, list.reborrow().get(index as u32), budget, depth + 1)?;
            }
        }
        Value::Object(values) => {
            let length = u32::try_from(values.len())
                .map_err(|_| InvalidControlFrame::new("JSON object is too large"))?;
            let mut entries = target.init_object_value(length);
            let mut values: Vec<_> = values.iter().collect();
            values.sort_by(|left, right| left.0.cmp(right.0));
            for (index, (key, value)) in values.into_iter().enumerate() {
                let mut entry = entries.reborrow().get(index as u32);
                entry.set_key(key.as_str());
                write_json(value, entry.init_value(), budget, depth + 1)?;
            }
        }
    }
    Ok(())
}

fn read_frame(
    root: wire_frame_capnp::wire_frame::Reader<'_>,
    budget: &mut Budget,
) -> Result<ControlFrame> {
    use wire_frame_capnp::wire_frame::Which;

    match root.which()? {
        Which::Request(value) => read_request(value?, budget),
        Which::Response(value) => read_response(value?, budget),
        Which::Signal(value) => read_signal(value?, budget),
        Which::FutureFrame(_) => Err(InvalidControlFrame::new("unsupported frame variant")),
    }
}

fn read_request(
    source: wire_frame_capnp::request::Reader<'_>,
    budget: &mut Budget,
) -> Result<ControlFrame> {
    if !source.has_id() || !source.has_call() || !source.has_args() {
        return Err(InvalidControlFrame::new("incomplete request"));
    }
    Ok(ControlFrame::Request {
        id: text(source.get_id()?)?,
        call: text(source.get_call()?)?,
        args: read_json(source.get_args()?, budget, 0)?,
        run_id: source
            .has_run_id()
            .then(|| source.get_run_id())
            .transpose()?
            .map(text)
            .transpose()?,
        body: source
            .has_body()
            .then(|| source.get_body())
            .transpose()?
            .map(read_body)
            .transpose()?,
    })
}

fn read_response(
    source: wire_frame_capnp::response::Reader<'_>,
    budget: &mut Budget,
) -> Result<ControlFrame> {
    use wire_frame_capnp::response::Which;

    if !source.has_id() {
        return Err(InvalidControlFrame::new("missing response id"));
    }
    let id = text(source.get_id()?)?;
    match source.which()? {
        Which::Success(value) => {
            let value = value?;
            Ok(ControlFrame::Response {
                id,
                ok: true,
                data: if value.has_data() {
                    OptionalJson::Present(read_json(value.get_data()?, budget, 0)?)
                } else {
                    OptionalJson::Absent
                },
                body: value
                    .has_body()
                    .then(|| value.get_body())
                    .transpose()?
                    .map(read_body)
                    .transpose()?,
                error: None,
            })
        }
        Which::Failure(value) => {
            let value = value?;
            if !value.has_error() {
                return Err(InvalidControlFrame::new("missing response error"));
            }
            Ok(ControlFrame::Response {
                id,
                ok: false,
                data: OptionalJson::Absent,
                body: None,
                error: Some(read_error(value.get_error()?, budget)?),
            })
        }
    }
}

fn read_signal(
    source: wire_frame_capnp::signal::Reader<'_>,
    budget: &mut Budget,
) -> Result<ControlFrame> {
    use wire_frame_capnp::signal::seq::Which;

    if !source.has_signal() {
        return Err(InvalidControlFrame::new("missing signal name"));
    }
    let seq = match source.get_seq().which()? {
        Which::Absent(()) => None,
        Which::Value(value) => {
            finite(value, "signal sequence")?;
            Some(value)
        }
    };
    Ok(ControlFrame::Signal {
        signal: text(source.get_signal()?)?,
        payload: if source.has_payload() {
            OptionalJson::Present(read_json(source.get_payload()?, budget, 0)?)
        } else {
            OptionalJson::Absent
        },
        seq,
    })
}

fn read_error(
    source: wire_frame_capnp::wire_error::Reader<'_>,
    budget: &mut Budget,
) -> Result<WireError> {
    use wire_frame_capnp::wire_error::retryable::Which;

    if !source.has_message() {
        return Err(InvalidControlFrame::new("missing response error message"));
    }
    let code = source.get_code();
    finite(code, "error code")?;
    let retryable = match source.get_retryable().which()? {
        Which::Absent(()) => None,
        Which::Value(value) => Some(value),
    };
    Ok(WireError {
        code,
        message: text(source.get_message()?)?,
        details: if source.has_details() {
            OptionalJson::Present(read_json(source.get_details()?, budget, 0)?)
        } else {
            OptionalJson::Absent
        },
        retryable,
    })
}

fn read_body(source: wire_frame_capnp::body_descriptor::Reader<'_>) -> Result<BodyDescriptor> {
    use wire_frame_capnp::body_descriptor::length::Which;

    let stream_id = source.get_stream_id();
    if stream_id == 0 {
        return Err(InvalidControlFrame::new("invalid body stream id"));
    }
    let length = match source.get_length().which()? {
        Which::Absent(()) => None,
        Which::Value(value) => {
            if value > MAX_SAFE_INTEGER_U64 {
                return Err(InvalidControlFrame::new("body length exceeds JSON range"));
            }
            Some(value)
        }
    };
    Ok(BodyDescriptor { stream_id, length })
}

fn read_json(
    source: wire_frame_capnp::json_value::Reader<'_>,
    budget: &mut Budget,
    depth: usize,
) -> Result<Value> {
    use wire_frame_capnp::json_value::Which;

    budget.consume(depth)?;
    match source.which()? {
        Which::NullValue(()) => Ok(Value::Null),
        Which::BoolValue(value) => Ok(Value::Bool(value)),
        Which::NumberValue(value) => {
            finite(value, "JSON number")?;
            number_from_f64(value).map(Value::Number)
        }
        Which::StringValue(value) => Ok(Value::String(text(value?)?)),
        Which::ArrayValue(values) => {
            let values = values?;
            let mut result = Vec::with_capacity(values.len() as usize);
            for value in values.iter() {
                result.push(read_json(value, budget, depth + 1)?);
            }
            Ok(Value::Array(result))
        }
        Which::ObjectValue(entries) => {
            let entries = entries?;
            let mut result = Map::new();
            let mut seen = HashSet::with_capacity(entries.len() as usize);
            for entry in entries.iter() {
                if !entry.has_key() || !entry.has_value() {
                    return Err(InvalidControlFrame::new("incomplete JSON object entry"));
                }
                let key = text(entry.get_key()?)?;
                if !seen.insert(key.clone()) {
                    return Err(InvalidControlFrame::new("duplicate JSON object key"));
                }
                result.insert(key, read_json(entry.get_value()?, budget, depth + 1)?);
            }
            Ok(Value::Object(result))
        }
    }
}

fn text(source: capnp::text::Reader<'_>) -> Result<String> {
    source
        .to_str()
        .map(str::to_owned)
        .map_err(|error| InvalidControlFrame::new(error.to_string()))
}

fn json_number(number: &Number) -> Result<f64> {
    if let Some(value) = number.as_u64() {
        if value > MAX_SAFE_INTEGER_U64 {
            return Err(InvalidControlFrame::new(
                "integer exceeds JavaScript JSON range",
            ));
        }
    } else if let Some(value) = number.as_i64() {
        if value.unsigned_abs() > MAX_SAFE_INTEGER_U64 {
            return Err(InvalidControlFrame::new(
                "integer exceeds JavaScript JSON range",
            ));
        }
    }
    let value = number
        .as_f64()
        .ok_or_else(|| InvalidControlFrame::new("invalid JSON number"))?;
    finite(value, "JSON number")?;
    Ok(value)
}

fn number_from_f64(value: f64) -> Result<Number> {
    if value.fract() == 0.0 && value.abs() <= MAX_SAFE_INTEGER_U64 as f64 {
        if value >= 0.0 {
            return Ok(Number::from(value as u64));
        }
        return Ok(Number::from(value as i64));
    }
    Number::from_f64(value).ok_or_else(|| InvalidControlFrame::new("invalid JSON number"))
}

fn finite(value: f64, label: &str) -> Result<()> {
    if value.is_finite() {
        Ok(())
    } else {
        Err(InvalidControlFrame::new(format!("invalid {label}")))
    }
}

#[derive(Clone, Copy)]
struct Budget {
    remaining_nodes: usize,
}

impl Budget {
    fn new() -> Self {
        Self {
            remaining_nodes: MAX_CONTROL_NODES,
        }
    }

    fn consume(&mut self, depth: usize) -> Result<()> {
        if depth >= MAX_CONTROL_NESTING {
            return Err(InvalidControlFrame::new("JSON nesting limit exceeded"));
        }
        self.remaining_nodes = self
            .remaining_nodes
            .checked_sub(1)
            .ok_or_else(|| InvalidControlFrame::new("JSON traversal limit exceeded"))?;
        Ok(())
    }
}

fn validate_unpacked(source: &[u8]) -> Result<()> {
    if source.len() > MAX_CONTROL_FRAME_BYTES {
        return Err(InvalidControlFrame::new("control frame exceeds byte limit"));
    }
    if source.len() < 8 || !source.len().is_multiple_of(8) {
        return Err(InvalidControlFrame::new(
            "invalid Cap'n Proto framing length",
        ));
    }
    let count_minus_one = read_u32(source, 0)?;
    if count_minus_one == u32::MAX {
        return Err(InvalidControlFrame::new("invalid segment count"));
    }
    let segment_count = count_minus_one as usize + 1;
    if segment_count > MAX_CONTROL_SEGMENTS {
        return Err(InvalidControlFrame::new("too many Cap'n Proto segments"));
    }
    let table_bytes = 4usize
        .checked_add(
            segment_count
                .checked_mul(4)
                .ok_or_else(|| InvalidControlFrame::new("segment table size overflow"))?,
        )
        .ok_or_else(|| InvalidControlFrame::new("segment table size overflow"))?;
    let header_bytes = table_bytes
        .checked_add(7)
        .ok_or_else(|| InvalidControlFrame::new("segment table size overflow"))?
        & !7;
    if header_bytes > source.len() {
        return Err(InvalidControlFrame::new("truncated segment table"));
    }
    let mut total_bytes = header_bytes;
    for index in 0..segment_count {
        let words = read_u32(source, 4 + index * 4)? as usize;
        if index == 0 && words == 0 {
            return Err(InvalidControlFrame::new("missing root segment"));
        }
        total_bytes = total_bytes
            .checked_add(
                words
                    .checked_mul(8)
                    .ok_or_else(|| InvalidControlFrame::new("segment size overflow"))?,
            )
            .ok_or_else(|| InvalidControlFrame::new("segment size overflow"))?;
        if total_bytes > MAX_CONTROL_FRAME_BYTES {
            return Err(InvalidControlFrame::new("segment sizes exceed byte limit"));
        }
    }
    if total_bytes != source.len() {
        return Err(InvalidControlFrame::new(
            "segment sizes do not match frame length",
        ));
    }
    Ok(())
}

fn read_u32(source: &[u8], offset: usize) -> Result<u32> {
    let bytes: [u8; 4] = source
        .get(offset..offset + 4)
        .ok_or_else(|| InvalidControlFrame::new("truncated segment table"))?
        .try_into()
        .expect("slice length checked");
    Ok(u32::from_le_bytes(bytes))
}

fn unpack_bounded(source: &[u8], max_bytes: usize) -> Result<Vec<u8>> {
    let mut source_offset = 0usize;
    let mut output_bytes = 0usize;
    while source_offset < source.len() {
        let tag = source[source_offset];
        source_offset += 1;
        let present = tag.count_ones() as usize;
        if present > source.len().saturating_sub(source_offset) {
            return Err(InvalidControlFrame::new("truncated packed word"));
        }
        source_offset += present;
        output_bytes = checked_add(output_bytes, 8, max_bytes)?;
        if tag == 0 {
            let words = *source
                .get(source_offset)
                .ok_or_else(|| InvalidControlFrame::new("truncated packed zero run"))?
                as usize;
            source_offset += 1;
            output_bytes = checked_add(output_bytes, words * 8, max_bytes)?;
        } else if tag == 0xff {
            let words = *source
                .get(source_offset)
                .ok_or_else(|| InvalidControlFrame::new("truncated packed literal run"))?
                as usize;
            source_offset += 1;
            let bytes = words * 8;
            if bytes > source.len().saturating_sub(source_offset) {
                return Err(InvalidControlFrame::new("truncated packed literal bytes"));
            }
            source_offset += bytes;
            output_bytes = checked_add(output_bytes, bytes, max_bytes)?;
        }
    }

    let mut output = vec![0; output_bytes];
    source_offset = 0;
    let mut output_offset = 0;
    while source_offset < source.len() {
        let tag = source[source_offset];
        source_offset += 1;
        for bit in 0..8 {
            if tag & (1 << bit) != 0 {
                output[output_offset] = source[source_offset];
                source_offset += 1;
            }
            output_offset += 1;
        }
        if tag == 0 {
            output_offset += source[source_offset] as usize * 8;
            source_offset += 1;
        } else if tag == 0xff {
            let bytes = source[source_offset] as usize * 8;
            source_offset += 1;
            output[output_offset..output_offset + bytes]
                .copy_from_slice(&source[source_offset..source_offset + bytes]);
            source_offset += bytes;
            output_offset += bytes;
        }
    }
    Ok(output)
}

fn checked_add(current: usize, increment: usize, limit: usize) -> Result<usize> {
    if increment > limit.saturating_sub(current) {
        Err(InvalidControlFrame::new(
            "packed control frame expands past byte limit",
        ))
    } else {
        Ok(current + increment)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Deserialize)]
    struct CorpusEntry {
        frame: ControlFrame,
    }

    fn corpus() -> Vec<ControlFrame> {
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../corpus/v3-frames.json");
        let entries: Vec<CorpusEntry> =
            serde_json::from_slice(&std::fs::read(path).expect("read corpus"))
                .expect("parse corpus");
        entries.into_iter().map(|entry| entry.frame).collect()
    }

    fn serialize(message: &Builder<capnp::message::HeapAllocator>) -> Vec<u8> {
        let mut bytes = Vec::new();
        capnp::serialize::write_message(&mut bytes, message).expect("serialize message");
        bytes
    }

    #[test]
    fn round_trips_protocol_v3_corpus() {
        for frame in corpus() {
            for packed in [false, true] {
                let encoded = encode_control_frame(&frame, packed).expect("encode frame");
                let decoded = decode_control_frame(&encoded, packed).expect("decode frame");
                assert_eq!(decoded, frame);

                let carrier = encode_v4_control_message(&frame, packed).expect("encode carrier");
                assert_eq!(
                    decode_v4_binary_message(&carrier).expect("decode carrier"),
                    V4BinaryMessage::Control {
                        frame: frame.clone(),
                        packed,
                    },
                );
            }
        }
    }

    #[test]
    fn routes_nonzero_stream_ids_to_the_unchanged_body_path() {
        let mut message = Vec::new();
        message.extend_from_slice(&41u32.to_le_bytes());
        message.push(3);
        message.extend_from_slice(b"external-body-bytes");
        assert_eq!(
            decode_v4_binary_message(&message).unwrap(),
            V4BinaryMessage::Body {
                stream_id: 41,
                flags: 3,
                payload: b"external-body-bytes",
            },
        );

        let mut unknown_control = [0; V4_BINARY_HEADER_BYTES];
        unknown_control[4] = 2;
        assert!(decode_v4_binary_message(&unknown_control)
            .unwrap_err()
            .to_string()
            .contains("unknown v4 control encoding"));
    }

    #[test]
    fn preserves_explicit_null_optional_json() {
        let frame = ControlFrame::Response {
            id: "null-data".to_owned(),
            ok: true,
            data: OptionalJson::Present(Value::Null),
            body: None,
            error: None,
        };
        let encoded = encode_control_frame(&frame, false).expect("encode null data");
        assert_eq!(decode_control_frame(&encoded, false).unwrap(), frame);
        assert!(serde_json::to_string(&frame)
            .unwrap()
            .contains("\"data\":null"));
    }

    #[test]
    fn old_reader_accepts_a_new_ordinary_field_and_zero_copy_forwarding_preserves_it() {
        let mut message = Builder::new_default();
        {
            let root = message.init_root::<wire_frame_capnp::wire_frame::Builder<'_>>();
            let mut request = root.init_request();
            request.set_id("evolution-1");
            request.set_call("prototype.call");
            request.set_revision_probe("added-field");
            write_json(
                &serde_json::json!({"known": true}),
                request.init_args(),
                &mut Budget::new(),
                0,
            )
            .unwrap();
        }
        let encoded = serialize(&message);

        let mut remaining = encoded.as_slice();
        let old_message =
            capnp::serialize::read_message_from_flat_slice(&mut remaining, ReaderOptions::new())
                .unwrap();
        let old_root = old_message
            .get_root::<wire_frame_v0_capnp::wire_frame::Reader<'_>>()
            .unwrap();
        let old_request = match old_root.which().unwrap() {
            wire_frame_v0_capnp::wire_frame::Which::Request(value) => value.unwrap(),
            _ => panic!("expected request"),
        };
        assert_eq!(
            old_request.get_id().unwrap().to_str().unwrap(),
            "evolution-1"
        );
        assert!(remaining.is_empty());

        let forwarded =
            capnp::serialize::write_message_segments_to_words(&old_message.into_segments());
        let mut remaining = forwarded.as_slice();
        let current_message =
            capnp::serialize::read_message_from_flat_slice(&mut remaining, ReaderOptions::new())
                .unwrap();
        let current_root = current_message
            .get_root::<wire_frame_capnp::wire_frame::Reader<'_>>()
            .unwrap();
        let current_request = match current_root.which().unwrap() {
            wire_frame_capnp::wire_frame::Which::Request(value) => value.unwrap(),
            _ => panic!("expected request"),
        };
        assert_eq!(
            current_request
                .get_revision_probe()
                .unwrap()
                .to_str()
                .unwrap(),
            "added-field",
        );

        let materialized = decode_control_frame(&encoded, false).unwrap();
        let rebuilt = encode_control_frame(&materialized, false).unwrap();
        let mut remaining = rebuilt.as_slice();
        let rebuilt_message =
            capnp::serialize::read_message_from_flat_slice(&mut remaining, ReaderOptions::new())
                .unwrap();
        let rebuilt_root = rebuilt_message
            .get_root::<wire_frame_capnp::wire_frame::Reader<'_>>()
            .unwrap();
        let rebuilt_request = match rebuilt_root.which().unwrap() {
            wire_frame_capnp::wire_frame::Which::Request(value) => value.unwrap(),
            _ => panic!("expected request"),
        };
        assert!(!rebuilt_request.has_revision_probe());
    }

    #[test]
    fn rejects_unknown_union_variants_in_current_and_old_decoders() {
        let mut message = Builder::new_default();
        message
            .init_root::<wire_frame_capnp::wire_frame::Builder<'_>>()
            .set_future_frame("future");
        let encoded = serialize(&message);
        assert!(decode_control_frame(&encoded, false)
            .unwrap_err()
            .to_string()
            .contains("unsupported frame variant"));

        let mut remaining = encoded.as_slice();
        let old_message =
            capnp::serialize::read_message_from_flat_slice(&mut remaining, ReaderOptions::new())
                .unwrap();
        let old_root = old_message
            .get_root::<wire_frame_v0_capnp::wire_frame::Reader<'_>>()
            .unwrap();
        assert!(matches!(old_root.which(), Err(capnp::NotInSchema(3))));
    }

    #[test]
    fn rejects_excessive_nesting_before_encoding() {
        let mut args = Value::Null;
        for _ in 0..MAX_CONTROL_NESTING {
            args = Value::Array(vec![args]);
        }
        let frame = ControlFrame::Request {
            id: "deep".to_owned(),
            call: "prototype.deep".to_owned(),
            args,
            run_id: None,
            body: None,
        };
        assert!(encode_control_frame(&frame, false)
            .unwrap_err()
            .to_string()
            .contains("nesting limit"));
    }

    #[test]
    fn rejects_a_small_packed_expansion_bomb() {
        let mut packed = Vec::new();
        for _ in 0..513 {
            packed.extend_from_slice(&[0, 255]);
        }
        assert!(packed.len() < MAX_CONTROL_FRAME_BYTES);
        assert!(decode_control_frame(&packed, true)
            .unwrap_err()
            .to_string()
            .contains("expands past byte limit"));
    }

    #[test]
    fn rejects_segment_tables_over_the_explicit_limit() {
        let segment_count = MAX_CONTROL_SEGMENTS + 1;
        let header_bytes = (4 + segment_count * 4 + 7) & !7;
        let mut encoded = vec![0; header_bytes + 8];
        encoded[..4].copy_from_slice(&((segment_count - 1) as u32).to_le_bytes());
        encoded[4..8].copy_from_slice(&1u32.to_le_bytes());
        assert!(decode_control_frame(&encoded, false)
            .unwrap_err()
            .to_string()
            .contains("too many"));
    }

    #[test]
    fn rejects_invalid_utf8_during_domain_materialization() {
        let frame = ControlFrame::Request {
            id: "unique-utf8-marker".to_owned(),
            call: "prototype.utf8".to_owned(),
            args: Value::Null,
            run_id: None,
            body: None,
        };
        let mut encoded = encode_control_frame(&frame, false).unwrap();
        let marker = b"unique-utf8-marker";
        let offset = encoded
            .windows(marker.len())
            .position(|window| window == marker)
            .expect("marker in encoded frame");
        encoded[offset] = 0xff;
        assert!(decode_control_frame(&encoded, false).is_err());
    }

    #[test]
    fn rejects_duplicate_object_keys() {
        let mut message = Builder::new_default();
        {
            let root = message.init_root::<wire_frame_capnp::wire_frame::Builder<'_>>();
            let mut request = root.init_request();
            request.set_id("duplicate");
            request.set_call("prototype.duplicate");
            let args = request.init_args();
            let mut entries = args.init_object_value(2);
            for index in 0..2 {
                let mut entry = entries.reborrow().get(index);
                entry.set_key("same");
                entry.init_value().set_bool_value(index == 0);
            }
        }
        let encoded = serialize(&message);
        assert!(decode_control_frame(&encoded, false)
            .unwrap_err()
            .to_string()
            .contains("duplicate"));
    }
}
