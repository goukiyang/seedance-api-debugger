// Exact additive bridges admitted from reviewed source pairs.
export default {
  // The review service uses separate, account-owned storage keys.
  "src/app/api/bridge/gpt-reviews/route.ts": {
    "previous": null,
    "current": "698cd0ea346eb8772046d83a72279d05ccdf729adc23a9aca618ee806c43d367"
  },
  "src/app/api/bridge/review-connect/[action]/route.ts": {
    "previous": "03c8ed4f0b92738788f3139588f7247bc0b6badcae622dedd41ce6c23c55f728",
    "current": "db2d103955e42a704e31ee3ea67b2f75d93af7c4dfd78b2eb7d37cfaf09fd0e7"
  },
  "src/app/api/bridge/review-mcp/route.ts": {
    "previous": null,
    "current": "86de78b56b09153e661ef583616c8a348540448c9904e2ce04999ae476419796"
  },
  "src/lib/bridge/gpt-review.ts": {
    "previous": "fd631a00a3d7e72d7cc76884a3f9c470b92672778fdaa54c7c8db75a941d5778",
    "current": "8b929fe6e564dd32a10b61ae16f687e3e0bc9ddf8b4ea03af778e7c7762579f2"
  },
  "src/lib/bridge/review-oauth.ts": {
    "previous": null,
    "current": "1f6411c340a089e6802f6614f73458feeaa8455557c02e6861ffddf6047be9b6"
  },
  "src/lib/bridge/review-pairing.ts": {
    "previous": null,
    "current": "33d9560bfaa7231081e7157274ac542c607a820c472e890da2e0bf7c82f5de67"
  },
  "src/lib/bridge/review-request.ts": {
    "previous": null,
    "current": "74c887a13b4ea4be07d49a2950adaf2b9dc7831a7ec7f7db9c2ebc857b05af51"
  },
  "src/lib/bridge/review-tool-image.ts": {
    "previous": null,
    "current": "d97523bd3fcad6809fa086762b9570099cb9379eb813f188ebe2ee054fc8730b"
  },
  // New account-private UserPreference namespace; no schema or existing writer protocol changes.
  "src/app/api/bridge/gpt-directory/route.ts": {
    "previous": null,
    "current": "1c5623be0f898e10320644b8608f41783b6c2c898cdc6371a045871d077534d5"
  },
  "src/lib/bridge/gpt-directory.ts": {
    "previous": null,
    "current": "497e86488f2ee7410316eeb5526fac69c2b3241ad72671bc4de3c97da69460c7"
  },
  // Read-only account-filtered logical storage accounting.
  "src/app/api/bridge/storage-usage/route.ts": {
    "previous": null,
    "current": "cf473257c8bbe4073029460651c3521215c2ce456d926007d832144e237e3e93"
  },
  "src/lib/bridge/storage-usage.ts": {
    "previous": "783b956ce8f1d7ef59bf3aa6c4b92fc83ec7e287d60843bbb56987c5ffa82e74",
    "current": "c628e1dd7abd604fadf10a513a2c883cfefd975985b4d32da71cb70a2626d105"
  },
  "src/app/api/image-studio/gallery/tags/route.ts": {
    "previous": null,
    "current": "60f59018aaca691de912bebdbabf32e3976d13da0f21805b83acd53c343f8783"
  },
  "src/lib/image-studio/gallery-directory-sql.ts": {
    "previous": "47676a3448514c0377ecb3e9a17472d628d9db81fd7ccfda337d4e49de5f1c91",
    "current": "6ef313766574bf6485619b22059af22706256c116088003254878cef86290156"
  },
  "src/lib/image-studio/gallery-page.ts": {
    "previous": "67a4035f0ec54ec17ee4188ff4fafcb0b6cd22f3f8b174116eb71f9213c1406f",
    "current": "ed5b88462ee00e5d40f398edcda887d89633458e0f6ce91b6649d12185930bbc"
  },
  "src/lib/image-studio/gallery-types.ts": {
    "previous": "af1667f889020aa6cc079aa89c570f3f66b468c0758f36674143461e8db53f32",
    "current": "a62ba506d8639b6dddb9fc2bc48d108dc3cdc23fb41c81882c57cbdb83128faf"
  },
  "src/lib/image-studio/gallery.ts": {
    "previous": "38bfa3dd7d80e1b9b3eb31ea36a4ab1fce9feaf32702f8b74298213b5744cfc3",
    "current": "7ced61d1cd29e128f86be55393b2df56933bef64ac10cb435686ae4cd211b0c0"
  },
  "src/lib/image-studio/template-tags.server.ts": {
    "previous": null,
    "current": "ee708cdb523303f214da30f4602a7b11899df7de06ac5673cfdecce393928501"
  },
  "src/lib/image-studio/template-tags.ts": {
    "previous": null,
    "current": "095add029e78ef64c0a61e383cf855515e85cf8c7a648b7e8828d6252375415f"
  },
  "src/lib/image-studio/synchronous-admission.ts": {
    "previous": "67a1c53406516b0b90c7159d3447db9a80bd2aca16cac2efcb32ce59611a4012",
    "current": "294bc37f200b8a6fbc08df63b62ddfd28fec2b6a343ab401e7a14bdabbd9c2c3"
  },
  "src/lib/image-studio/process-provenance.ts": {
    "previous": null,
    "current": "7c2371f1ea8ab685d409a1ba72ce8ce3796a2e6075d244760296dff01c45ad5b"
  },
  "src/lib/pricing/runtime.ts": {
    "previous": "1ebf813f1bb6065dc4153e0482c7348ba4b41bd63cfbfbaa1efa44d5ca747f2b",
    "current": "c795b8f6c3370cf1402d78989a6f1d66757f9f1c2a9c7887f4e210dd3fe2317a"
  },
  "src/lib/image-studio/tasks.ts": {
    "previous": "3a7425f9b3db691bf9d94d5e51a2a6cf2a0c197e9b4e3b8743b34d4b1e0e5c1d",
    "current": "dffb4b265da81fd8f127d020db04b471e49b0d7bcd0476134f0f0d1aaf9bdf6e"
  },
  "scripts/process-image-studio.ts": {
    "previous": "8dcd164f4d243ca952f8f7ee615f9c99a7e125ff7b03f07edf7e72287b148acd",
    "current": "156f8013abf0fda69839fe0671e658dd5e0af50ca122eba509517112f8599540"
  },
  "src/lib/security/private-prompts.server.ts": {
    "previous": "ae549459c929465abbe7afdebc302a19f81a0ab2af2e8569f76c382db755d246",
    "current": "c86f5f0701c819612402ead0f23ada2255cf308dfdd6df70e736383b9ab64db2"
  },
  "src/app/api/tasks/[id]/reuse/route.ts": {
    "previous": "3235ddd39438362e0cfeb71e3b0323493dd508ea8a13a437b2518f12f2ca7bbb",
    "current": "0e21bc786eb89e696348fcd4caa375a759972adf4561a4d7183ee2ca3fcb59b9"
  },
  "src/lib/navigation/return-to.ts": {
    "previous": "43c505a2f43194f0c6623ab27f3fe82d78a92f3129957e95654e7b75ce49f5a2",
    "current": "f3bb58c1211ca4faa3b4d849613488d40f056febd66a552d82904e6f90b63786"
  },
  "src/lib/navigation/task-reuse-operation.server.ts": {
    "previous": "f21dd26c366fc23de806f16a0480e454749d016273f0320e6fb63baa38e0efa4",
    "current": "74dbb5d6b6c7ffd7e450ca3a8ffd96680a96e489ab863bc1921321df27614796"
  },
  "src/lib/works/provenance.ts": {
    "previous": "cf3b8b81967a97347783c31b77ebf993e9140463ed1532ea47c1812151e71c7d",
    "current": "36fd5e1391738fb1f9c1301a8d43fafd2f7d3fed95f95e9d0b30fe03a3b0eb69"
  },
  "src/lib/works/query.ts": {
    "previous": "5162413b765d91ff2178efa837afc5cdaae898b3fce63a9b29281e23bbc4a329",
    "current": "0eb0af0c62ddcac9cd93c082f5f244eeaee1cde75359b100010332cc045db7c0"
  },
  "src/lib/works/types.ts": {
    "previous": "e3eb62906806a39e4d6277bbeb4664fea61fc6dccf52abb20c3eaad4f2aebd1d",
    "current": "316800206ed912b19889bb85fe0402acb5e5210465007ac2ca62652fa14f84ef"
  },
  "src/lib/template-studio/worker.ts": {
    "previous": "979db85e3fd75e6833ca0be1962ebff81063ef1fc0a1948b2bb194c646839681",
    "current": "e8405e4f42033710450f6f4d6c6d4dcaa031059c54ec2b80bf1d27feae01b1a6"
  },
  "src/lib/template-studio/assets.ts": {
    "previous": "7adf93646006c92e776f3811ed1c4abc1c5d04cd1e51593fa44a379e3ae7d7e3",
    "current": "318969b2ab61a4038b49d7a0706d1a9b741069b4b3d08961117ca5f5f04a71ed"
  },
  "src/lib/template-studio/private-migration.server.ts": {
    "previous": "6609babd44bef102b18ab757383400a263098defcad8b9f790ef8186004252ea",
    "current": "f600f9026a3ecc158930dc2f0b4e8ba47ea711054a11416c008f0061351349b2"
  },
  "src/lib/video/multiview-action-contract.ts": {
    "previous": "55f081440894bf13d7347e5d55db29c7359a57f1e4f0edac4b7de86f408dc0ec",
    "current": "e33d532c04e447b709e76699d30c40f7154083bc5db4458bebe3f8e9cb4456bb"
  },
  "src/lib/video/multiview-action.server.ts": {
    "previous": "908ba7f4eea708a4aa49060cebc3b9d928317d61fbf6a70f67fe591e64b9aaf1",
    "current": "0376b323e599af1164fabfb061ed481bb774a7af2ac8e054a4b73b5cb511abf0"
  },
  "src/app/api/video/multiview/actions/reference-runs/route.ts": {
    "previous": null,
    "current": "ced158868a0076a1830747077e6b7d193a7ee8d0531ba94fa7411580cc04bf5d"
  },
  "src/lib/template-studio/types.ts": {
    "previous": "4069178b69d76090e5c6b979f05eeb39356a252f907323cdded757e9897136ba",
    "current": "22ec0832222b27821bbdb25a893ca1884f6a713af973cc3e023b3fcadc588f98"
  },
  "src/lib/video/multiview-action-restore-contract.ts": {
    "previous": null,
    "current": "18fdaea4167c9e21298179c53efa3e15d06d08a5ccf427bf9052f2554715a5ff"
  },
  "src/lib/video/multiview-action-restore.server.ts": {
    "previous": null,
    "current": "e8b535b98a96b41a8b4f8c0c05fc677b73fcaae4381b4aeaea436bad41f154e5"
  },
  "src/app/api/video/multiview/actions/restore/route.ts": {
    "previous": null,
    "current": "187a814ce5fd31995029018f54f6afe0e12b8e248c12c56c7cc361c7246aa957"
  },
  "src/app/api/assets/library/route.ts": {
    "previous": "565200c1406940675240e61da925484827d7c51aa159d78d2cace09411335f93",
    "current": "d84d56aac497c2a493fa85145b1bc6afe00eb393302f396483baa9edeaddcf3a"
  },
  "src/app/api/content-reactions/media/route.ts": {
    "previous": "bd44d20c5baf84574369497b20bf82203c39825d2dcc9d4eaf09b8f36a7b5813",
    "current": "5a957d5240a043edac99b2cf192a428d5f29d281173cf897af50b4c96400807b"
  },
  "src/app/api/ip/tasks/create/route.ts": {
    "previous": "b64816a163f97e5ae74fa8b43edf10f95d81cf5a1dfbea0de5000bb3f9132460",
    "current": "77b53bbf7995c7572d3cc975c5804965d374d70e7e544c0edc580c84c03d518b"
  },
  "src/app/api/provider/reference-media/route.ts": {
    "previous": null,
    "current": "eb4c8da84d9167cf2cffcec793708c77ee29ae66380e34bc8b73a4a148ff8058"
  },
  "src/app/api/reference-images/[id]/content/route.ts": {
    "previous": "e5a50db569c503a834bdea0bd96baa49ef4d5dfdac0a9c921fc68f2785f11d36",
    "current": "e072ea796049e6827368632211e6a215b1edb4f4fb1e3a071df357cb399c0569"
  },
  "src/app/api/tasks/create/route.ts": {
    "previous": "03fab647076efbf8c4e9a9535e55f5c6e4798f2feb422f11f7f9b1b14e9c0c95",
    "current": "6187bb01d8c9f8ce6b00997b954bec455553aaeecad63a8837203f61122087aa"
  },
  "src/app/api/tasks/request-status/route.ts": {
    "previous": "055872c1708de76b67549bb394da5e4426d406d43d642323b2e422bd14c713a5",
    "current": "c0bcfa231176dce4206c998ec7956a04bfb46b3e295631fdc428320b8c19ea3d"
  },
  "src/lib/content-reactions/content.ts": {
    "previous": "e0d271e2b6c2c97ace737fa391e880c767aac07b437e7b509bdde6b6a1b13144",
    "current": "77441a0e6aedf80d2ee50acc76799c292d77c276b87359bccc0b6713dc696d11"
  },
  "src/lib/generation-retry/store.ts": {
    "previous": "2141b2b4521cc77fdee2da74721dc53659a9f22779e03f496f8e19cc71ed16de",
    "current": "207b31d3644745b6fe3061d4fe8d4bc2ae3dc71e8495269db441343236af1969"
  },
  "src/lib/generation-retry/video.ts": {
    "previous": "c833a3af25281c0d93f0a3ca61aec19f2ae36b39c3d44c97c4505fa34b2de468",
    "current": "97a2c5e09ad4e13c024e0a34fcccdd787e6a78940311dbadba57d39ca563f424"
  },
  "src/lib/hooks/useWorkspace.ts": {
    "previous": "49d9611855fcdca853f541bd37ab339ec1bf69e8299f1e79d1762d87c670f01d",
    "current": "ac13b950e540950d573833e38ea6692db1299805e126102c718b0cf8782fd93c"
  },
  "src/lib/image-studio/media.ts": {
    "previous": "f2a3cf5cfbe936e61f114b1330b97d429efa426f5f5b260960b245c33a88bcc7",
    "current": "d4f28e34e08c98d120a1fcaea7466454eab252cc5c4ec03d719c41939fe9e348"
  },
  "src/lib/media/authorized-image-response.ts": {
    "previous": "3cf24e0755b54a5f9945af1808c258ff50c20d2903da4e24ad2635641b805cec",
    "current": "9adcac9aa83642d4081620d62a6e9632ff27c0e4f8976a16cc7436fa4787aa63"
  },
  "src/lib/provider/create-diagnostic.ts": {
    "previous": "c097cdf8458045138f4e276cc1892e11e800c84d34f5f8c42aacc83d32d79f72",
    "current": "40faed5e9cddd36c5cb290a3b537f2b74146f27515fd0bfc0b80d0d5cc0f4a38"
  },
  "src/lib/provider/ip-reference-media-metadata.ts": {
    "previous": "fdfa077871b4d03ad1b24095f69d41761b7e0bfd8a68c344d79563612bad9e27",
    "current": "d9b8b016eff5dd5ace932db2548fa062366ae54e9cd97656f39e39bfd0e4fa51"
  },
  "src/lib/provider/jimeng.ts": {
    "previous": "24ed422657a0fb0bc381dff8937e78923da83f32f7d6a80f271a5fdb246bc376",
    "current": "e89e6a445714ca7d104a816a44602c4d93e4ee3beb0001128ded55d15c817920"
  },
  "src/lib/provider/reference-media-redaction.ts": {
    "previous": null,
    "current": "284040507f25703a4138c9959c2d6370e4162c9f7a4852b6c91bf1218135d188"
  },
  "src/lib/provider/reference-video-delivery-build-mode.ts": {
    "previous": null,
    "current": "ffdc9ad2cf4a54240cb1dd78c3fe4fbb67c37c8e3bb0355ce1c5b88b1a8c0dfe"
  },
  "src/lib/provider/reference-video-delivery.server.ts": {
    "previous": null,
    "current": "bfb2755f8da7fbc395566981d30df01a462e61539ea6a28907633e577f73caa7"
  },
  "src/lib/provider/volcengine-ip.ts": {
    "previous": "563c1081e97cee22b2fc90ea5ccc1558fc69a00930efe6138e6ece135d21ca23",
    "current": "757c99b4b93342698a311c028d42f27d6b2708e1472fa667cb9f43bd3c11f1ea"
  },
  "src/app/api/assets/picker/route.ts": {
    "previous": "3b9b537584c58ccac17e40ac80852da908d811113414fb8237d30681e31925de",
    "current": "cb3e3e7f143f2bf575d8ee6413ccb4cd558457ee207d8994e05d40d9b886fd6d"
  },
  "src/lib/assets/picker-directory.ts": {
    "previous": "402600692ece66070f5a235672550bea8fa3dbcb83efce47d168c2f6dbecb231",
    "current": "2d97039774165f86a450a9138aafe05345477c9c098f26d9db343a070201b845"
  },
  "src/lib/assets/picker-types.ts": {
    "previous": "d168af82085aaa9a1038d2471ad82034bf456c255d5839080c8252d2d8fbc754",
    "current": "ba4e4797e012f570b56b75d2bdf384750a6fa66bf13f7d4912109ffeb7844cdf"
  },
  // Member video API. The paired guard reads the same private results and staged additive schema.
  "prisma/migrations/20261127200000_customer_api/migration.sql": {
    "previous": null,
    "current": "32eb4984669242769d528d47ad148dde0a71d214b8cbd07d8384bc8d4562d264"
  },
  "prisma/schema.prisma": {
    "previous": "379b407353322149ca872671b64ca98916482af653a78d4f0fa8d917bef6c7f0",
    "current": "95c40c9e5665ad8dceabb68103b14fcc93574149c1cd4c22d7e64bad3f5081a3"
  },
  "scripts/finalize-pending-videos.ts": {
    "previous": "5a4ddfbbee72212fbb6b73d48d45c9f4a9871cdbd0355ab5f0a91690617a5aea",
    "current": "abe5bff11db9f141e14985705927e2fdefcc6afe65fcb89088c0cef8180ccd4b"
  },
  "src/app/api/admin/api-clients/route.ts": {
    "previous": null,
    "current": "27608455b5686d1a253f36e6d18eced9f6cde54f4b827fd765907f954c362889"
  },
  "src/app/api/approvals/[id]/route.ts": {
    "previous": "8def3304b1d796bf7b26db9849d7a9b132d0b2d5cc85887039661d92934e5f3f",
    "current": "62a13a5af320a44a16d0f7fbeda4377592036f3de909c0679213d48feb54be02"
  },
  "src/app/api/approvals/route.ts": {
    "previous": "61c5ca2d448a949c9320d3a92d4c3d79a15f1ad74e27ccb9ab29211ad5f15e26",
    "current": "be52fb7cdb8aa76d49357e56140f2ac35459da6c6545667649ca52113575edfa"
  },
  "src/app/api/assets/library/bulk-move/route.ts": {
    "previous": "a3be40b0477dcbcb0d621d788f64b0ca500ee0ccdf11978645cfc103f8ce2e28",
    "current": "1a0313f506ce1dd7e5782049aa5ee20d67f0cde85e1760e5a382d48f90a85400"
  },
  "src/app/api/internal/customer-media/[id]/route.ts": {
    "previous": null,
    "current": "0cafdfc0d9ec1909ccf39a3236e54ce519ec0628553859ba5d35e9e3bac12c6b"
  },
  "src/app/api/internal/customer-video/[id]/route.ts": {
    "previous": null,
    "current": "ffcaa5ab2ab1cb57cf67a65f53220c3cbcf16c32012747a1199e25b29e33cfc6"
  },
  "src/app/api/me/api-access/route.ts": {
    "previous": null,
    "current": "edc2fc206dbe8c0fad3b91e277fda8e0dcef494626d896fd821ba0f0565bb9bc"
  },
  "src/app/api/v1/[...path]/route.ts": {
    "previous": null,
    "current": "2428d24ce7c5f2f735bde0db232a09ffc0d6b6be95850794e0d7652be48083d0"
  },
  "src/app/api/video/download/[id]/route.ts": {
    "previous": "9687b456bca4219bbf3bcbe6dab48a6b42623296201f0c066492e437bdb2fada",
    "current": "69aaa56abf8b7d65c08a205970916549113d8a0d010476bc9ddd10e9088f95b5"
  },
  "src/app/api/video/play/[id]/route.ts": {
    "previous": "99e23216c99d4ca078f6d935963acadbcbd551596295f28fd170c3cd81468e0f",
    "current": "58e6093258825a4174fb27c57f4eecc5febeb65b41aeecbf9f1ff4714a513efe"
  },
  "src/app/api/video/thumbnail/[id]/route.ts": {
    "previous": "8579392ecc844f2ac9439313e2bb259f98a806bdb148e030acf5726afa12033d",
    "current": "8a7e5cf3920868b4d772909e681df67d048abc00e0972dd258f1dc05abc64ba3"
  },
  "src/lib/approvals.ts": {
    "previous": "ce548304078a11d9e1083bb54e9f207acae4bf8deac065b37b17b6e7eff42e1a",
    "current": "ed79051e1d98807c67656c8b4e545bb345aa7384c0d53b671171fdd14a8d61f5"
  },
  "src/lib/assets/library-directory.ts": {
    "previous": "5e2f809b840416481cb96cc36578ee53643ce1107db6e0e44d1477b48c45c9f8",
    "current": "8eaaff3172ce92df8b87f4eed7878ecce10c608e6ba233c45a2d5bf14b05ccc3"
  },
  "src/lib/assets/raw-upload-state.ts": {
    "previous": "2f705fc2e536bf910ff24dd2c5c76e4023f234f207e6a929e310594e13a19e25",
    "current": "33a9494e6886481b515a9737556cb3942880ed5de16eab4fcc329282df39048e"
  },
  "src/lib/assets/verified-upload.ts": {
    "previous": "d666f0af356d155821e15b9e4b8889908c27d1cf17a4a8e8a93ddfed3f4d893a",
    "current": "5b0a5bfc68ca43786f5e208e84a247cd93ad3855441928b9a27dcdd2fab17bf1"
  },
  "src/lib/credits/policy.ts": {
    "previous": "535efce33a82954984ea92ea66cfa463091ab6fd354c45728a37755e5474dd0f",
    "current": "a743b347a2275a8a10770a9e2f8277b397b14408638784999afdbb9ac379220d"
  },
  "src/lib/customer-api/admin.ts": {
    "previous": null,
    "current": "a3ff0ad11f940f85d43285cfd72fcb5b964e86aee49b23653718f6522d0cdd82"
  },
  "src/lib/customer-api/admission.ts": {
    "previous": null,
    "current": "652de8c8d256463e9c7a2bf4a37a18a3c4732efba3f689e5b0c310b8b307024d"
  },
  "src/lib/customer-api/auth.ts": {
    "previous": null,
    "current": "472cef04f7281e6a5b08fa9c25cbebb405c8307f65ab8cb68044f69f2dcaf5f0"
  },
  "src/lib/customer-api/contracts.ts": {
    "previous": null,
    "current": "6cc6e6779d411d2e60367ff198d3f22f5c8ae3e8b70d8926c7b96fc71edd37ac"
  },
  "src/lib/customer-api/file-response.ts": {
    "previous": null,
    "current": "f34fcd3c185758d949959d49dc795f56c514d23704d25008d8b88dff721c1f35"
  },
  "src/lib/customer-api/input-assets.ts": {
    "previous": null,
    "current": "4e155d2955e891d60fcc6413c36c10694a6abe8009544e8fe92b9bac9b6aed61"
  },
  "src/lib/customer-api/members.ts": {
    "previous": null,
    "current": "9f541fcef9e33f463c5f51f6140381ffb567e97dfc54f34b699a2b48e5af2b99"
  },
  "src/lib/customer-api/output.ts": {
    "previous": null,
    "current": "683f32013cab8ada0d56ad8d5d48c075dc55e87c096b72d685f77090d245e82e"
  },
  "src/lib/customer-api/private-media.ts": {
    "previous": null,
    "current": "735d726541e7655d4b69de235f2600f6011d453cd8c99c7deb66fd3722540330"
  },
  "src/lib/customer-api/recovery.ts": {
    "previous": null,
    "current": "2f3f266198339cdd3e786af3ed2fecbf18a7474af6b674a24ed63a48db528005"
  },
  "src/lib/customer-api/tasks.ts": {
    "previous": null,
    "current": "2b804e95efd8c08324b8285c71332ee66f68314040db9ad0b13fdcf6a102cc8c"
  },
  "src/lib/customer-api/uploads.ts": {
    "previous": null,
    "current": "407c44838964e62a352c2de0be0a1e4016be7f3f9fb076ccd38f7f17325accd6"
  },
  "src/lib/customer-api/usage.ts": {
    "previous": null,
    "current": "3d11c517caf22381c22277c366c5a401b9295834068e1eed0c49e645b10cd3a1"
  },
  "src/lib/projects/permissions.ts": {
    "previous": "5d5fada44fa95eba9b93865ff4206387e680a2c31adb1edae0019bcf813a1470",
    "current": "9fcc684c4381b8f28b826562c500d02612bae0cf432488c7b07c4adee6058733"
  },
  "src/lib/provider/video-task-status.ts": {
    "previous": "78b8526e3e4a2e8ec19042e989635ea516a2ab31daadf5d2c7801719085b8ce8",
    "current": "21cf7d156236a7975dd4005d1b8de1546c89f8a18c3adfcea88902155081b2c0"
  },
  "src/lib/tasks/paid-generation-guard.ts": {
    "previous": "26983d545134f71ae82f5ded7ba8e3eb9c06cedd903ee47ac0a3864f43e6b2f0",
    "current": "d704ee9e0efb8cbd2e2d73327caadc7a2c5d7bb16dc0d682a5b61e2023dd8ff7"
  },
  "src/lib/video/bulk-download.ts": {
    "previous": "f9671cf22d9c51b7df208ad31105a62a04bceecc92bfd3823193aa1874220ad4",
    "current": "b835c8f33a50e41590ab4bc4929d4a2510d5e92323bc204f1283e0af00e0dc51"
  },
  "src/lib/video/delivery-status.ts": {
    "previous": "fe116e2630c90317aad6b8e9eaad0f7f88a96dfa629f54b8798565144613fff7",
    "current": "a4969e40ff0779452ef884884fcb07d4122a4c149f230100d667218247b755cf"
  },
  "src/lib/video/finalize-pending-candidates.ts": {
    "previous": "2b67db9876c74809c532e6c10aed9f60559385f9e332d1374df7c61bc6351eaf",
    "current": "5614b945ec100dffea37867d3a9ba11e4e27ea49b56d2b8d0f708a7fc4267506"
  },
  "src/lib/video/ip-create.ts": {
    "previous": null,
    "current": "20b558733dffe87bc85dd9b2e7057931e0350c99f805577a6650acc6f6215f92"
  },
  "src/lib/video/local-cache.ts": {
    "previous": "2fd94f34ed3b45a2594ba22e69e36a9cca659a0d32ac36ebab964a11c3dfa126",
    "current": "ce13b18acf6ca3f30d3eeb0b179f63424009cedbebf1f858b7b1788298058018"
  },
  "src/lib/video/media-ingest.ts": {
    "previous": "f819a780702b31d9694775a8c18bc0b184ec275a6664dfda014677da16461916",
    "current": "6e45462d09c965aaebb4f850e7ee12bd5436cc30bb2b7ae405e057db90f198d7"
  },
  "src/lib/video/public-delivery.ts": {
    "previous": "c7c125a690e5b3cbc48106b315114c4f80b6cbe3c8e19419186bd67a926b33cb",
    "current": "5816966f1d8c025e880e2876cf2513c3acd7ed88ef32c8179d42a840fc3ee9fc"
  },
  "src/lib/video/save-lock.ts": {
    "previous": "0a84283f3ef47d7efe96978937b242e972b2c376b3b376dd5d5c37173c16516c",
    "current": "e62805c6baec6c83074f0ae1a3041e7f24021bc6adeb59f80ffe87f7bb3633d0"
  },
  "src/lib/video/task-finalizer.ts": {
    "previous": "335b6406dc7dd6a298be25ca0ecb1d8f1ef99fa52837ef8fdb0db38895345d32",
    "current": "d8753d184b81540ce390bb46717ad4108c73306a4231ac8d8e4c9573a32ea0df"
  },
  "src/lib/video/task-localization-runner.ts": {
    "previous": "f66323dae2b4d61c5b333050c054775beaa4bf303222245c2141a755d85584e4",
    "current": "c067de826c08dc222dba63f4e6df85facf48c7a4fb2326ad5749e1985f2283e2"
  },
  "src/lib/video/thumbnail.ts": {
    "previous": "0b5acffb5c23fcfc3524f047088cfca3922e31878a8375ecd82e17869761dd01",
    "current": "346aa49c377d9f4b3ca81b31a003c08da8bef27c73ce95e65617383457671320"
  },
};
