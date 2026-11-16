import { BudgetAllocations } from "../src/runtime/budget-allocation.ts";

const [command, parentPath, id, childPath, azure, exa, ...extra] = process.argv.slice(2);
if (!parentPath || !id || extra.length || !["provision", "status", "reconcile", "abandon"].includes(command ?? "")
  || command === "provision" && (!childPath || !azure || !exa)
  || command !== "provision" && childPath !== undefined) {
  throw new Error("Usage: node --import tsx scripts/budget-allocation.ts provision PARENT_DB ID CHILD_DB AZURE_CAP EXA_CAP | status|reconcile|abandon PARENT_DB ID");
}
const allocations = new BudgetAllocations(parentPath);
try {
  if (command === "provision") {
    const child = allocations.provision(id, childPath!, { azure: Number(azure), exa: Number(exa) });
    child.close();
  } else if (command === "reconcile") allocations.reconcile(id);
  else if (command === "abandon") allocations.abandonPreparation(id);
  console.log(JSON.stringify(allocations.status(id), null, 2));
} finally { allocations.close(); }
