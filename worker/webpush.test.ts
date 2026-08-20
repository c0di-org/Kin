import { describe, expect, it } from "vitest";
import { b64urlToBytes, bytesToB64url, encryptPushPayload } from "./webpush";

const compact = (value: string) => value.replace(/\s+/g, "");

describe("RFC 8291 push encryption", () => {
  it("matches the published example ciphertext", async () => {
    const plaintext = new TextEncoder().encode("When I grow up, I want to be a watermelon");
    const body = await encryptPushPayload(
      b64urlToBytes(compact("BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcx aOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4")),
      b64urlToBytes("BTBZMqHH6r4Tts7J_aSIgg"),
      plaintext,
      {
        salt: b64urlToBytes("DGv6ra1nlYgDCS1FRnbzlw"),
        senderPublic: b64urlToBytes(compact("BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIg Dll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8")),
        senderPrivate: b64urlToBytes("yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw")
      }
    );
    expect(bytesToB64url(body)).toBe(compact(`
      DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27ml
      mlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPT
      pK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN
    `));
  });
});
