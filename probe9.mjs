import * as KeetaNet from '@keetanetwork/keetanet-client';
const signer = KeetaNet.lib.Account.fromSeed(KeetaNet.lib.Account.generateRandomSeed({asString:true}),0);
const uc = KeetaNet.UserClient.fromNetwork('main', signer);
const client = uc.client;
const S = (v) => JSON.stringify(v, (k,x) => {
  if (typeof x === 'bigint') return String(x);
  if (x && typeof x === 'object' && typeof x.publicKeyString?.get === 'function') return x.publicKeyString.get();
  return x;
});
// KTA token account has many storage ACLs (from earlier probe)
const acls = await client.listACLsByPrincipal(KeetaNet.lib.Account.fromPublicKeyString('keeta_anqdilpazdekdu4acw65fj7smltcp26wbrildkqtszqvverljpwpezmd44ssg'));
console.log('count:', acls.length);
console.log('entry[0]:', S(acls[0]));
console.log('entry[1]:', S(acls[1]));
await uc.destroy?.();
