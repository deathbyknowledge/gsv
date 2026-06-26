import DefaultTheme from "vitepress/theme";
import { h } from "vue";
import NavTitle from "./components/NavTitle.vue";
import "./custom.css";

export default {
  extends: DefaultTheme,
  Layout() {
    return h(DefaultTheme.Layout, null, {
      "nav-bar-title-before": () => h(NavTitle),
    });
  },
};
