import { expect, it } from "vitest";
import { AuthorizedPostingReceipt } from "@/features/accounting/authorized-posting";
const receipt = { resourceId:"11111111-1111-4111-8111-111111111111", sourceVersion:1, status:"posted", journalId:"22222222-2222-4222-8222-222222222222", number:"JOURNAL-20260101-000001", debit:"100.00", credit:"100.00", requestId:"original-request" };
it("retains a typed immutable original posting response",()=>{expect(AuthorizedPostingReceipt.parse(receipt)).toEqual(receipt);});
it.each([100,"1e2","NaN","Infinity","100.001","01.00","1000000000000000000.00"])("rejects unsafe receipt money %s",amount=>{expect(()=>AuthorizedPostingReceipt.parse({...receipt,debit:amount,credit:amount})).toThrow();});
it("rejects empty or imbalanced receipts and unlisted client approval metadata",()=>{
  expect(()=>AuthorizedPostingReceipt.parse({...receipt,debit:"0.00",credit:"0.00"})).toThrow();
  expect(()=>AuthorizedPostingReceipt.parse({...receipt,credit:"99.99"})).toThrow();
  expect(()=>AuthorizedPostingReceipt.parse({...receipt,approved:true})).toThrow();
});
