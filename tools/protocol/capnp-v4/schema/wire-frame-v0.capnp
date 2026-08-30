@0xdcff2e147b98825c;

# Previous schema snapshot used only by the evolution compatibility tests.

struct WireFrame {
  union {
    request @0 :Request;
    response @1 :Response;
    signal @2 :Signal;
  }
}

struct Request {
  id @0 :Text;
  call @1 :Text;
  args @2 :JsonValue;
  runId @3 :Text;
  body @4 :BodyDescriptor;
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
