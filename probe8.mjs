import * as KeetaNet from '@keetanetwork/keetanet-client';
const signer = KeetaNet.lib.Account.fromSeed(KeetaNet.lib.Account.generateRandomSeed({ asString: true }), 0);
const uc = KeetaNet.UserClient.fromNetwork('main', signer);
const client = uc.client;
const J = (v) => JSON.stringify(v, (k, x) => typeof x === 'bigint' ? String(x) : x);
const T = (p, ms) => Promise.race([p, new Promise((_, r) => setTimeout(() => r(new Error('timeout')), ms))]);

for (const addr of ['keeta_amnkge74xitii5dsobstldatv3irmyimujfjotftx7plaaaseam4bntb7wnna',
                    'keeta_anutgo4o3yp5tvc6wjt4vzsehjbn7t2wylpxmam4d4ojtdkjj2yca2qoinfcs']) {
  try {
    const info = await T(client.getAccountInfo(KeetaNet.lib.Account.fromPublicKeyString(addr)), 15000);
    console.log('=== TOKEN', addr);
    console.log(J(info).slice(0, 700));
  } catch (e) { console.log('err', e.message); }
}
// ACL probe on a random account
try {
  const acls = await T(client.listACLsByPrincipal(signer), 15000);
  console.log('ACLs for random acct:', Array.isArray(acls) ? acls.length : J(acls).slice(0, 400));
  if (Array.isArray(acls) && acls[0]) console.log('acl keys:', Object.keys(acls[0]));
} catch (e) { console.log('acl err:', e.message); }
await uc.destroy?.();
