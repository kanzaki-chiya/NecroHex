/**
 * 字节视图。.hex 是 white-space: pre，所以用渲染函数逐个写出文本节点，与 Mockup 的 DOM 相同：
 * 每行 <span class="off">、每字节 <span class="b …"> 加一个空格、<span class="asc">、换行。
 */
import { defineComponent, h, type PropType, type VNode } from "vue";
import type { HexRow } from "../state/logic.ts";

export default defineComponent({
  name: "HexBlock",
  props: { rows: { type: Array as PropType<readonly HexRow[]>, required: true } },
  setup(props) {
    return () => {
      const kids: (VNode | string)[] = [];
      for (const r of props.rows) {
        kids.push(h("span", { class: "off" }, r.off));
        for (const c of r.cells) kids.push(h("span", { class: c.cls }, c.text), " ");
        kids.push(h("span", { class: "asc" }, r.asc), "\n");
      }
      return h("div", { class: "hex", id: "hex" }, kids);
    };
  },
});
