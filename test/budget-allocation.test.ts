import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BudgetAllocations } from "../src/runtime/budget-allocation.ts";
import { ProviderSpendStore } from "../src/runtime/spend-store.ts";

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "asof-allocation-")), path = join(dir, "parent.db"), childPath = join(dir, "child.db");
  const parent = new ProviderSpendStore({path, caps:{azure:3,exa:1}});
  const allocator = new BudgetAllocations(path);
  return {dir,path,childPath,parent,allocator,close(){allocator.close();parent.close();rmSync(dir,{recursive:true,force:true});}};
}
test("delegated allowance is held globally, reused on restart, and reconciled only after fencing the child", () => {
  const x=setup();
  try {
    let child=x.allocator.provision("preview",x.childPath,{azure:2,exa:0.5});
    assert.equal(x.parent.getSummary().providers.azure.heldDollars,2);
    assert.throws(()=>x.parent.reserve({provider:"azure",maxDollars:1.01}));
    const bill=child.reserve({provider:"azure",maxDollars:0.4});bill.markStarted();bill.settle(0.25);child.close();
    child=x.allocator.provision("preview",x.childPath,{azure:2,exa:0.5});
    assert.equal(child.getSummary().providers.azure.spentDollars,0.25);
    assert.equal(x.parent.getSummary().providers.azure.reservations,1);
    const receipt=x.allocator.reconcile("preview");
    assert.equal(receipt.providers.azure.spentDollars,0.25);
    assert.throws(()=>child.reserve({provider:"azure",maxDollars:0.01}),/locked/);
    assert.deepEqual(x.allocator.reconcile("preview"),receipt);
    assert.equal(x.parent.getSummary().providers.azure.spentDollars,0.25);
    assert.equal(x.parent.getSummary().providers.azure.heldDollars,0);
    assert.throws(()=>x.allocator.provision("preview",x.childPath,{azure:2,exa:0.5}));
    child.close();
  } finally{x.close();}
});
test("a missing activated child cannot reset spending and changed caps cannot acquire a new hold",()=>{
  const x=setup();try{
    const child=x.allocator.provision("preview",x.childPath,{azure:1,exa:0.2});child.close();
    assert.throws(()=>x.allocator.provision("preview",x.childPath,{azure:2,exa:0.2}));
    rmSync(x.childPath);
    assert.throws(()=>x.allocator.provision("preview",x.childPath,{azure:1,exa:0.2}),/missing/);
    assert.throws(()=>x.allocator.reconcile("preview"),/intact/);
    assert.equal(x.parent.getSummary().providers.azure.heldDollars,1);
  }finally{x.close();}
});
test("a crash with unresolved child reservations consumes the full parent hold without refund",()=>{
  const x=setup();try{
    const child=x.allocator.provision("preview",x.childPath,{azure:1,exa:0.2});
    child.reserve({provider:"azure",maxDollars:0.1}).markStarted();child.close();
    const receipt=x.allocator.reconcile("preview");
    assert.equal(receipt.providers.azure.pendingDollars,0.1);
    assert.equal(x.parent.getSummary().providers.azure.spentDollars,1);
    assert.equal(x.parent.getSummary().providers.azure.unknownSettlements,1);
  }finally{x.close();}
});
test("partial allocation failure cannot issue a child; an unissued hold can be abandoned",()=>{
  const x=setup();try{
    assert.throws(()=>x.allocator.provision("preview",x.childPath,{azure:1,exa:2}));
    assert.equal(x.allocator.status("preview")!.state,"preparing");
    assert.equal(x.parent.getSummary().providers.azure.heldDollars,1);
    x.allocator.abandonPreparation("preview");
    assert.equal(x.parent.getSummary().providers.azure.remainingDollars,3);
    assert.equal(x.allocator.status("preview")!.state,"closed");
  }finally{x.close();}
});

test("a provision racing abandonment cannot create an orphan hold after closure", () => {
  const x = setup(), other = new BudgetAllocations(x.path);
  try {
    const parent = (x.allocator as any).parent as ProviderSpendStore;
    const reserve = parent.reserveDelegation.bind(parent);
    parent.reserveDelegation = (id, provider, cap) => {
      other.abandonPreparation(id);
      return reserve(id, provider, cap);
    };
    assert.throws(() => x.allocator.provision("race", x.childPath, { azure: 1, exa: 0.2 }), /closing or issued/);
    assert.equal(x.allocator.status("race")!.state, "closed");
    assert.equal(x.parent.getSummary().providers.azure.heldDollars, 0);
    assert.equal(x.parent.getSummary().providers.azure.spentDollars, 0);
    assert.equal(existsSync(x.childPath), false);
  } finally { other.close(); x.close(); }
});

test("abandonment interrupted after its fence resumes without requiring never-created holds", () => {
  const x = setup();
  try {
    assert.throws(() => x.allocator.provision("interrupted", x.childPath, { azure: 1, exa: 2 }));
    const parent = (x.allocator as any).parent as ProviderSpendStore;
    const resume = parent.resumeReservation.bind(parent);
    parent.resumeReservation = () => { throw new Error("Injected process interruption"); };
    assert.throws(() => x.allocator.abandonPreparation("interrupted"), /Injected/);
    assert.equal(x.allocator.status("interrupted")!.state, "closing");
    parent.resumeReservation = resume;
    x.allocator.abandonPreparation("interrupted");
    x.allocator.abandonPreparation("interrupted");
    assert.equal(x.allocator.status("interrupted")!.state, "closed");
    assert.equal(x.parent.getSummary().providers.azure.remainingDollars, 3);
  } finally { x.close(); }
});

test("an empty replacement child cannot manufacture a fresh allowance or a refund", () => {
  const x = setup();
  try {
    const child = x.allocator.provision("replacement", x.childPath, { azure: 1, exa: 0.2 });
    child.reserve({ provider: "azure", maxDollars: 0.4 }).settle(0.3); child.close();
    rmSync(x.childPath); writeFileSync(x.childPath, "");
    assert.throws(() => x.allocator.provision("replacement", x.childPath, { azure: 1, exa: 0.2 }), /identity/);
    assert.throws(() => x.allocator.reconcile("replacement"), /identity/);
    assert.equal(x.parent.getSummary().providers.azure.heldDollars, 1);
  } finally { x.close(); }
});

test("concurrent closers settle the winning durable receipt rather than their stale snapshots", () => {
  const x = setup(), other = new BudgetAllocations(x.path);
  const originalSeal = ProviderSpendStore.prototype.seal;
  let child: ProviderSpendStore | undefined, nested = false;
  try {
    child = x.allocator.provision("closers", x.childPath, { azure: 1, exa: 0.2 });
    const bill = child.reserve({ provider: "azure", maxDollars: 0.5 }); bill.markStarted(); bill.settle(0.2);
    ProviderSpendStore.prototype.seal = function(reason) {
      const earlier = originalSeal.call(this, reason);
      if (!nested && this.path === x.childPath) {
        nested = true;
        assert.throws(() => bill.settle(0.3), /billing exceeded/);
        other.reconcile("closers");
      }
      return earlier;
    };
    const receipt = x.allocator.reconcile("closers");
    assert.equal(receipt.providers.azure.spentDollars, 0.3);
    assert.equal(x.parent.getSummary().providers.azure.spentDollars, 0.3);
    assert.equal(x.allocator.status("closers")!.receipt!.providers.azure.spentDollars, 0.3);
  } finally { ProviderSpendStore.prototype.seal = originalSeal; child?.close(); other.close(); x.close(); }
});

test("separate processes cannot allocate more than the parent's remaining money", { timeout: 15000 }, async () => {
  const x = setup();
  try {
    const run = (index: number) => new Promise<number | null>((resolve, reject) => {
      const code = `import { BudgetAllocations } from './src/runtime/budget-allocation.ts';
        let a; try { a = new BudgetAllocations(process.env.TEST_PARENT); const c = a.provision('parallel'+process.env.TEST_INDEX, process.env.TEST_CHILD, {azure:1,exa:0.2}); c.close(); }
        catch { process.exitCode=2; } finally { a?.close(); }`;
      const child = spawn(process.execPath, ["--import", "tsx", "--disable-warning=ExperimentalWarning", "--input-type=module", "--eval", code],
        { env: { ...process.env, TEST_PARENT: x.path, TEST_CHILD: join(x.dir, `child-${index}.db`), TEST_INDEX: String(index) }, stdio: "ignore" });
      child.once("error", reject); child.once("exit", resolve);
    });
    const results = await Promise.all([0, 1, 2, 3].map(run));
    const succeeded = results.filter(code => code === 0).length;
    assert.ok(succeeded >= 1 && succeeded <= 3);
    const summary = x.parent.getSummary();
    assert.ok(summary.providers.azure.spentDollars + summary.providers.azure.heldDollars <= 3);
    assert.ok(summary.providers.exa.spentDollars + summary.providers.exa.heldDollars <= 1);
    assert.equal(summary.providers.azure.violations, 0);
  } finally { x.close(); }
});
