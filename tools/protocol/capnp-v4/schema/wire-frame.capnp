@0xdcff2e147b98825c;

# Experimental protocol-v4 control envelope. Stream bytes remain in the
# existing stream-id-keyed WebSocket body frames and never enter this message.

struct WireFrame {
  union {
    request @0 :Request;
    response @1 :Response;
    signal @2 :Signal;
    futureFrame @3 :Text;
    # Evolution probe: current decoders reject this variant. The v0 fixture
    # does not know its discriminant, which exercises unknown-union handling.
  }
}

struct Request {
  id @0 :Text;
  call @1 :Text;
  args @2 :JsonValue;
  runId @3 :Text;
  body @4 :BodyDescriptor;
  revisionProbe @5 :Text;
  # Evolution probe: ordinary encoders leave this null. The v0 fixture lacks
  # the field so tests can verify old-reader/new-writer behavior.
}

struct Response {
  id @0 :Text;
  union {
    success @1 :ResponseSuccess;
    failure @2 :ResponseFailure;
  }
}

struct ResponseSuccess {
  data @0 :JsonValue;
  body @1 :BodyDescriptor;
}

struct ResponseFailure {
  error @0 :WireError;
}

struct Signal {
  signal @0 :Text;
  payload @1 :JsonValue;
  seq :union {
    absent @2 :Void;
    value @3 :Float64;
  }
}

struct WireError {
  code @0 :Float64;
  message @1 :Text;
  details @2 :JsonValue;
  retryable :union {
    absent @3 :Void;
    value @4 :Bool;
  }
}

struct BodyDescriptor {
  streamId @0 :UInt32;
  length :union {
    absent @1 :Void;
    value @2 :UInt64;
  }
}

struct JsonValue {
  union {
    nullValue @0 :Void;
    boolValue @1 :Bool;
    numberValue @2 :Float64;
    stringValue @3 :Text;
    arrayValue @4 :List(JsonValue);
    objectValue @5 :List(JsonEntry);
  }
}

struct JsonEntry {
  key @0 :Text;
  value @1 :JsonValue;
}
