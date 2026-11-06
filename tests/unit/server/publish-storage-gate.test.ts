// @vitest-environment node
import { afterEach,expect,it,vi } from "vitest";
import { FilesystemGate } from "../../../server/publish/storageGate";
afterEach(()=>vi.restoreAllMocks());
it("does not start an expired queued writer even when the event loop has delayed timers",async()=>{
 let now=10;vi.spyOn(Date,"now").mockImplementation(()=>now);
 const gate=new FilesystemGate(1,1,5000);let release!:()=>void;
 const work=new Promise<void>(resolve=>{release=resolve;});
 const first=gate.submit(async lease=>{expect(lease.beginIO()).toBe(true);await work;return "retained";});
 await Promise.resolve();
 const later=vi.fn(async lease=>{lease.beginIO();return "must-not-run";});
 const queued=gate.submit(later);now=6000;release();await gate.idle();
 await expect(first.result).rejects.toMatchObject({code:"publish_storage_timeout"});
 await expect(queued.result).rejects.toMatchObject({code:"publish_storage_timeout"});
 expect(later).not.toHaveBeenCalled();expect(await queued.settled).toMatchObject({ioStarted:false});
 expect(await first.settled).toMatchObject({ok:true,ioStarted:true});expect(gate.stats).toEqual({active:0,queued:0});
});
