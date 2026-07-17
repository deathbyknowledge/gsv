import { describe, expect, it, vi } from "vitest";
import { consumeSetupTokenFromFragment } from "./setupToken";

function createHistory() {
  return {
    state: { navigation: "state" },
    replaceState: vi.fn(),
  };
}

describe("consumeSetupTokenFromFragment", () => {
  it("consumes the fragment token and removes every copy from the URL", () => {
    const history = createHistory();
    const token = consumeSetupTokenFromFragment({
      pathname: "/",
      search: "?source=managed",
      hash: "#view=setup&setupToken=first%2Dtoken&setupToken=second-token",
    }, history);

    expect(token).toBe("first-token");
    expect(history.replaceState).toHaveBeenCalledWith(
      history.state,
      "",
      "/?source=managed#view=setup",
    );
  });

  it("never reads a setup token from the query string", () => {
    const history = createHistory();
    const token = consumeSetupTokenFromFragment({
      pathname: "/",
      search: "?setupToken=query-secret",
      hash: "#view=setup",
    }, history);

    expect(token).toBeUndefined();
    expect(history.replaceState).not.toHaveBeenCalled();
  });

  it("removes an empty setup token without retaining it", () => {
    const history = createHistory();

    expect(consumeSetupTokenFromFragment({
      pathname: "/",
      search: "",
      hash: "#setupToken=",
    }, history)).toBeUndefined();
    expect(history.replaceState).toHaveBeenCalledWith(history.state, "", "/");
  });
});
