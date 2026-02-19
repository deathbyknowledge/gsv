import type { Handler } from "../../protocol/methods";

export const handleNodesList: Handler<"nodes.list"> = ({ gw }) => {
  const inventory = gw.getRuntimeNodeInventory();
  return {
    nodes: inventory.hosts,
    count: inventory.hosts.length,
  };
};
