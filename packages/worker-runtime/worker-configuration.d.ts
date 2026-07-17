declare namespace Cloudflare {
  interface Env {
    TEST_OBJECTS: DurableObjectNamespace<import("./test/worker").PortableDoFixture>;
  }
}

interface Env extends Cloudflare.Env {}
