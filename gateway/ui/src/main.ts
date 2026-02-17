import "./styles.css";

const mount = document.getElementById("app");
if (!mount) {
  throw new Error("Missing #app mount node");
}

const params = new URLSearchParams(window.location.search);
const useReactUi = params.get("ui") === "react";

if (useReactUi) {
  import("./react/bootstrap").then(({ mountReactApp }) => {
    mountReactApp(mount);
  });
} else {
  import("./ui/app").then(() => {
    const app = document.createElement("gsv-app");
    mount.replaceChildren(app);
  });
}
