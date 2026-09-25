import assert from "node:assert/strict";
import { prospectsFromComments, prospectsFromPaste } from "./fb-comments";

const found = prospectsFromComments([
  { name: "Sam Buyer", text: "Send the address to sam.buyer@example.com please", groupName: "DFW Wholesale" },
  { name: "Home Pros", text: "details to deals@selltohomepros.com", groupName: "DFW Wholesale" },
  { name: "Sam Buyer", text: "again sam.buyer@example.com", groupName: "DFW Wholesale" },
]);
assert.equal(found.length, 1);
assert.equal(found[0].email, "sam.buyer@example.com");
assert.equal(found[0].name, "Sam Buyer");
assert.equal(found[0].groupName, "DFW Wholesale");

const pasted = prospectsFromPaste("Alex Rivera: alex@flip.test\nno email here\nbare@buyer.test");
assert.deepEqual(pasted.map((p) => p.email), ["alex@flip.test", "bare@buyer.test"]);
assert.equal(pasted[0].name, "Alex Rivera");
assert.equal(pasted[1].name, "bare@buyer.test");

console.log("fb-comments: all passed");
