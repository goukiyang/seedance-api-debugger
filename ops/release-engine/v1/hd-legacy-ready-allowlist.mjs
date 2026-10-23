// Explicit root-approved historical exception. Do not discover or extend this
// list at runtime. The original evidence is legacy-ready-inventory-20261019.json.
// Its exact bytes are pinned by inventorySha256; no media URL or body is stored.
function freeze(value) {
  if (value && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
  return value;
}

export const APPROVED_HD_LEGACY_READY = freeze({
  "schema": "hd-legacy-ready-approval-v1",
  "inventorySha256": "effd9cbe7b6014585fa43b56065edd1883ed4c2267e2dd26601b9ee920f98b9b",
  "inventorySchema": "hd-legacy-ready-inventory-v1",
  "canonicalRoot": "/data/video-api-debugger/var-lib/storage/hd-derivatives",
  "binding": {
    "dev": "64784",
    "ino": "171598992"
  },
  "count": 60,
  "observedAt": "2026-10-19T18:23:59.139682+00:00",
  "sourceObserved": "53eb8b54228fa844960b8c9c8015227af0f99bc8",
  "entries": {
    "025cdcb763bab2c4feb72c6c67dab52f66fe9e3b60111833cacb94390e068f7f": {
      "manifestSha256": "3a7682590c1b3e758f5bbc25ab64333be1b461b08325033e673cd3e9d8332711",
      "sourceIdentitySha256": "33240d99cdfc7a5930538f19c0ea0b298ea0b964457852bc1ae6564b32324ab6",
      "sourceVersion": "64784:171450419:11986436:1791360458008.7117:1791360458022.712"
    },
    "072e3497169da62a057db1ec5c09ff1e1de4fbed164e1ef32890163023f2b045": {
      "manifestSha256": "7d256a332960537611d2a07cc7d38d691810a8a670038c4ed06a35177db35bbf",
      "sourceIdentitySha256": "2bd6b2d5648de9e800f7277bdfbdb3b95df994fb06f39e01a02838988f2cb610",
      "sourceVersion": "64784:171450413:11217121:1791359752822.3818:1791359752837.382"
    },
    "0da10f9f224439a2cbc03d3872032fde0040da1bb04a157a245c96089218b521": {
      "manifestSha256": "ee0198fdc6fa9486076fd3fc78ac5cfb5cbe77d2973f7a02c53a2fbec633cc41",
      "sourceIdentitySha256": "e791fa589696780bdce1489f4835f383e9e2976b937a813e36b96a80831b5996",
      "sourceVersion": "64784:171450330:235537:1791306878504.3235:1791306878504.3235"
    },
    "13df8c92864c0e5ba433d88880bb491f1188dc3ebff6c255a79ec219157e19ec": {
      "manifestSha256": "50e8ed365f14e61ce1f90427ab2ca750c7f616d54d22f9cf72bcc7f52c7e2713",
      "sourceIdentitySha256": "1ea54bdfcfc209cfa20e61cd4dd7cd7196c0165a3f5d2546957db6c788bfaea2",
      "sourceVersion": "64784:171450399:19724217:1791318444979.9714:1791318444997.9717"
    },
    "1a8db707031e3378c6347eba5037bb04c51de2049076c8967616bcaf797e088d": {
      "manifestSha256": "0e51d1e5f17ae742e0c3054642d3f6e694747958dab19e8318f3e1f3c6011302",
      "sourceIdentitySha256": "4d3b6c854618fe14f34bf839d90ce368ee6deb15fcf361c47db64bbf773ccd3d",
      "sourceVersion": "64784:171450477:1760492:1791381178469.0884:1791381178469.0884"
    },
    "1b5d896938590fe0c4041b8d831d6fb3ed973360cc948794fb49c36fdce04f32": {
      "manifestSha256": "1dc67954316da32b2cb740558bde0131105e2005dd2529b430778f4c47c2e123",
      "sourceIdentitySha256": "ed8eee4adbe3bb871a588c0e45c8b43bad53a7a087f1f6b450162f0acddf770c",
      "sourceVersion": "64784:171450461:1560628:1791369036410.679:1791369036410.679"
    },
    "21888f8b8395e3646acb1145023d19f85854fda5b159d36982fa1544593dd71f": {
      "manifestSha256": "275141bed716ed16755da6b2f8844fe73fbd9acd6caf2f7994ada7968a322249",
      "sourceIdentitySha256": "cdf48c72a4ba859392722cae146896b9c712f6df3e5684fbbc3e8c11006b6ffd",
      "sourceVersion": "64784:171450387:13371568:1791317058323.9973:1791317058338.9976"
    },
    "2c4a8d0300b38fefa95234f03d92716b43136f649fbf40a41f4bb70120aa9f20": {
      "manifestSha256": "dbec83d0136734b08d036229f2353613691dc81a68ae6e1dd406619087f99197",
      "sourceIdentitySha256": "0d9caf741fbe1090120bde9a89a9ab217b7bcab67d0dbeee23906a845f72c8e0",
      "sourceVersion": "64784:171450354:4456932:1791313414122.184:1791313414122.184"
    },
    "2dd6faf3b9f751f7775b9dc82f0c45e0e3f78b12960a408dd1a5f8974367a44e": {
      "manifestSha256": "1ad6205a8a880a1ea5ccfcbdca680b6a994d558032cba1c3af362277fcf6d299",
      "sourceIdentitySha256": "2e6d2f75a88da5f0f685cf1137dbacf746af835de37918d13e32d1de327b0dd7",
      "sourceVersion": "64784:171450344:9722118:1791311249850.4348:1791311249862.435"
    },
    "301bbfacfc76bdc5becf49634ea0c8e84a1788ad2ead3a3e692b125ed48dd5d9": {
      "manifestSha256": "337c66a97a59164204f2926084786cf159570551c2b4934a08057e0ad34f17a3",
      "sourceIdentitySha256": "632ebb953ae883d92e23712f9269db74832f01a8a7e874fbbc6798bc5fa8048c",
      "sourceVersion": "64784:171450435:13628819:1791362487509.0466:1791362487523.0466"
    },
    "315b2c8a973402d707028f138e87bbd31e10465e7d2b465da4341c9761f53430": {
      "manifestSha256": "0544fcb23c283c1f3b8bad7d4f6f4b5699f1ed8739bbfe82aaa1b98e3dd19365",
      "sourceIdentitySha256": "766b2f33f986b173852a5e46c144e54c70fdab63723fb1eeb97e7e3f9e98b456",
      "sourceVersion": "64784:171450389:17361304:1791317224348.3164:1791317224368.3164"
    },
    "339344d9434ce574d857f3d981e41d0769ed7f0418d965a1233d4b7b6e2d3b49": {
      "manifestSha256": "8b461c5cdbf04d29d5382ffd2fcd083910d6c5f35f4abc88f3b966ec1c1e820c",
      "sourceIdentitySha256": "50483d740f871619c88a8a4007a7916561965ab54ec66d309c1153cbe9865363",
      "sourceVersion": "64784:171450451:14724806:1791365991438.9248:1791365991455.925"
    },
    "3ef8f27ced8fde2951e6840040efa62375cf8f3f9d09d05079bb66f2e69476eb": {
      "manifestSha256": "6fa61548206107c6bb79ab4c6ba7d4103d4f0855e58a202f5423b9c9077c3575",
      "sourceIdentitySha256": "df008511ea5570e073d1a047f2cf7b8ae115a9a83c2cbf0b4020eb752b62cd8e",
      "sourceVersion": "64784:171450395:19381414:1791317703149.1138:1791317703164.1138"
    },
    "4238b8fae091bf78ddc6cde557510bc9afaab668d99cde85b9cdbe601ec3f7e3": {
      "manifestSha256": "aae5a5d2fa04de60cc3d5a7a6af49e39b1e141632e728c3ef39f091acc76fa63",
      "sourceIdentitySha256": "fc17bd20765190447192de757f4d3f8c5f384b6e4bd3c4faa9d5a94de9af97ee",
      "sourceVersion": "64784:171450338:9642247:1791308428430.6157:1791308428440.6157"
    },
    "45cb60a93756f9f4168c3464291a06a5ffdef99f51c404fbf0b2a6d656b9e3c8": {
      "manifestSha256": "d159de858a6be3f40deb34d7ce629e4c74e7f831583be9b3ef6ed044a0c5be02",
      "sourceIdentitySha256": "e7e12963497594e73881636d0adb9a8826fa9d4a61b3f5ed68eeb272930e61e0",
      "sourceVersion": "64784:171450346:13070474:1791311433942.893:1791311433955.893"
    },
    "47883e7c3edfa4a593e1132ef2490f81eb5c5827cf4daf10e895ef65315089ac": {
      "manifestSha256": "b2e33a57cc9454aba9fc76de23fce95aed2e2d1f1be879dc3ed94c7a385e0b9d",
      "sourceIdentitySha256": "e5efec79ba8227bf5faef1c69d2991a77fb596494b58c39cc22e4690ccb63b46",
      "sourceVersion": "64784:171450352:16853911:1791312072825.7095:1791312072842.7095"
    },
    "492290bc5dacc03309c5820cae3c235191f655b66db283cd2480faf8a21beec7": {
      "manifestSha256": "a3ef4c6560de7a739d811c87c27fcea92487a3daad3dc6e3a75a866bf513b961",
      "sourceIdentitySha256": "940d976f565f0b0d6890b79ad6804160ad403849de666834aa1f8ca69dadc313",
      "sourceVersion": "64784:171450417:13686411:1791360449812.65:1791360449831.65"
    },
    "4dce24bed1de031281b6af20d18ed64c2d18fbdd492917e2ad0778de00034f46": {
      "manifestSha256": "2d9151ae7f847b2722576a5e3510f1569ddb4a22e61a690e06aa00f395001795",
      "sourceIdentitySha256": "228597d45f35cdc7be49389f974836eac9d14e58ab1942562f34385cd497e422",
      "sourceVersion": "64784:171450439:14634587:1791363652535.3457:1791363652554.3457"
    },
    "5050f707e4b5a9a486f92518eb686ae54ec0de7488d3b4f1d440c21b7aeefbbe": {
      "manifestSha256": "6401aa230078365f984fa52cd0228284a2fedce2e39f044bcd7f7171a3c58b83",
      "sourceIdentitySha256": "2e6cee14c3541db957d5c8afdc3dff27080bbf5361478940edbe0694b4c010ff",
      "sourceVersion": "64784:171450427:15399753:1791361945849.6895:1791361945865.6897"
    },
    "5ae88a1e7f03d9244557005b3c9fe5ee92ffb7cab4a18872099edf50baac1752": {
      "manifestSha256": "88e021e8a406ee8d861965e8a8e7a40db2691ac4a9a1165922d4c4b7ace4327d",
      "sourceIdentitySha256": "52113a9164c092b1bfed5a48229a9b3799c74db80c08af4bf54058be7b80dcba",
      "sourceVersion": "64784:171450350:11423986:1791311804333.639:1791311804345.639"
    },
    "5d0316a68685b241b3910aae549c6a3ba92eda3eb6d184a5e4fc8f2d35cce1d1": {
      "manifestSha256": "4e14f2727ed490f512a8234964a5f07c647f9e0492f4eb5b1a3ced771efeb9fc",
      "sourceIdentitySha256": "a0d638ffcf0c5aa890f474968b1c97c6c8ae30ab7b570d3eb80304c78e4cb790",
      "sourceVersion": "64784:171450483:1105412:1791386445408.0244:1791386445408.0244"
    },
    "5d77cdb8d702609660b2a95cb2de77a239cf225d031fbebf1a51443505d474a4": {
      "manifestSha256": "de10872a92cd03340d4cf21bd1e30862b1f71819fa08e0a4d9254569fffe9035",
      "sourceIdentitySha256": "f369ef4e792533989b5bb0b04f4ef7eb3594da0b8118de287303ed1e403ef5d2",
      "sourceVersion": "64784:171450415:2790449:1791359848841.1084:1791359848841.1084"
    },
    "644f458574d0bcb421a19b8016a01e42e8ceb581a5827a12fb17c4e7290a0c65": {
      "manifestSha256": "12ae3b498ee1da662dced75ff89250fbbe774a8316541b99c8905d3c68f3cea4",
      "sourceIdentitySha256": "ed21b7d1e5d3de15bb6520ec95a0915eecb792aa126fd4ab93c4f80e37998b21",
      "sourceVersion": "64784:171450391:18992540:1791317386526.604:1791317386543.604"
    },
    "69202dc6e0d8b9a42c29afecc3611f800ed99187b81002105f6e479b7f73eb5a": {
      "manifestSha256": "42ec649e0c06ee2048b2148b169aa94f11716bec4e58c6021ad6b3a30745f7de",
      "sourceIdentitySha256": "c307d205da06a1ee47400fced9a894ceb2f471b06153a3ee20a6b219179f2e02",
      "sourceVersion": "64784:171450455:13186555:1791366873643.0786:1791366873657.0786"
    },
    "6ab66bb73a9a16d9ede20b67971179f3d62e156447423800eac15d7da7ed656c": {
      "manifestSha256": "b38eb8d31ca922fbea1d4dc2fef7fad43e35ba6e11ae22e01297f58a8abe840b",
      "sourceIdentitySha256": "9b06c4d2b0761446befa9462df6cdc7915525ba272f324488a78060d825bd5a6",
      "sourceVersion": "64784:171450457:9511463:1791368290160.514:1791368290174.5142"
    },
    "6b49fa7627002805e579e0af1fc3d298863c8498793cfce05e7ea0da65bddbb6": {
      "manifestSha256": "690a642c1dcacbf75ac5a15d0dc9ca7a2c468612e3ed85c674c99381a354e46f",
      "sourceIdentitySha256": "c798ba661fbfe243b87670375976a7b73d813c76bbd9e6b86dd937d4c0e98473",
      "sourceVersion": "64784:171450425:15630029:1791361939468.6382:1791361939488.6384"
    },
    "73f166f6f0ea5ad852e2c6b79a7b2cec3cd043fd7461622168fcbff8ee9099f0": {
      "manifestSha256": "4445e9381a125d4402ea9af82af22bc7d037983943ef2f0e30131b4b4704e65d",
      "sourceIdentitySha256": "926d9a0d28efc2d7422802d57273bb22b4d6731c71608427646d268f36854038",
      "sourceVersion": "64784:171450443:15032295:1791365221329.7573:1791365221346.7573"
    },
    "7427f34d5998aad17c312bd0d03250b3f5172ec3eb82a0119c4163536dfcb551": {
      "manifestSha256": "a63f084148b201e2836d0e8f7ad90bd649bdee7642257d2563c02a4721bdc8a5",
      "sourceIdentitySha256": "98010a1e1d80f6e60427706e1acedd297aa5ee9c10727ba6203e09e9fb04a397",
      "sourceVersion": "64784:171450449:14896022:1791365906422.242:1791365906437.242"
    },
    "76cc3db06b068b548a9779c67d1b386d8641ec9217137678d432b531cf790a77": {
      "manifestSha256": "52d248645bfd6cf6beecb46f695f32aebf23fb0347d6b13ee624252130c82c92",
      "sourceIdentitySha256": "f013fa5498da3454b674b39ce54fe91f03b93bd8660a10a1c856db4c63c44a83",
      "sourceVersion": "64784:171450401:19180345:1791318619861.3062:1791318619885.3062"
    },
    "791472287b10fd783f0f3940054a03b32b1db0f63308e47250b27813fccedd7b": {
      "manifestSha256": "ff4fcce3b96b57703d7dfbb41cf5b09824a604d9e84c6ffa82e034e7e5782ffb",
      "sourceIdentitySha256": "fe61f80617da725c752d682872f40a596ca7d7d62834a8a92d0354c26ca98b50",
      "sourceVersion": "64784:171450393:19931408:1791317543038.8445:1791317543057.8447"
    },
    "7c1b5491e41957f6496726870cd9bb3cf2396c32345eb59cac764dc4f2031af7": {
      "manifestSha256": "0b820f0cbbc5da732d33f8f36495f18dbb9466904c57e6b519d4567238efdbe0",
      "sourceIdentitySha256": "a677c16a76d3fbf0062ec3b33c97d4f0596a28083a2f7901182015fd09830990",
      "sourceVersion": "64784:171450332:8528404:1791306977421.1091:1791306977434.1091"
    },
    "7ece8946eaf90510d2cf90ebce7702a21cf20024600e55542bf74ec3cf59ef1c": {
      "manifestSha256": "14f03c8ba66a24a259a611af9da356fd9829627835c1df0b6e762194cf96db8d",
      "sourceIdentitySha256": "6837e26dd8f1b4b01a76de01eccad6f22c240bbfa95b2c46b7f6523470dbf54e",
      "sourceVersion": "64784:171450381:9867385:1791316230666.426:1791316230679.426"
    },
    "7f199aaf9c96fb48dd7ff49cd8ac9816558e429dbab6db2da4a832a5fc7adab0": {
      "manifestSha256": "3e067065db2f61e07b1a50493f0afd74d3eb6455e5085a7cf727d32c10bc4cad",
      "sourceIdentitySha256": "c14693d3c39bc3d1c0675cb8ff848630ca7a8c6771c98bb383c4488e2bed49ba",
      "sourceVersion": "64784:171450437:14432792:1791363340172.8616:1791363340186.8616"
    },
    "826a0a2464f7a01276728ae4a73766797d4236c229ecce4397169516035d81ff": {
      "manifestSha256": "835c2789c43d5dd1370c296e88016f854e3b08c9f364c02ffeee0196303d45a3",
      "sourceIdentitySha256": "bc9208bee0e3d5e66da45f6845c528dd676dc7f1137eb6f7d0541da9c104e978",
      "sourceVersion": "64784:171450334:128781:1791307036997.5815:1791307036997.5815"
    },
    "8b91a0671e97f77aecafcf7ed90b28cf340ac382a7798d48f0f5d8f7abd5d017": {
      "manifestSha256": "d905c6c4a07136d6af628c76e2e635cb2ea49b25110052b517bcce1ec173d12f",
      "sourceIdentitySha256": "5b51f268f95d828926d2c106793ab982ebe800e59730616815cb7087ec66fe2f",
      "sourceVersion": "64784:171450383:16617746:1791316401672.781:1791316401688.7812"
    },
    "971384bc02b5beb74fdb1a9fcbbb203360803b34fc2ae5a025e33e46c2c8b0ae": {
      "manifestSha256": "828dbce12643e23e261fb0db86dea92ba23b2bf42ecf93810bccaa6157d4bf97",
      "sourceIdentitySha256": "394143b8ec6bc86507077d69105309f4a1d4ed713033ae2d1e4166039af6195e",
      "sourceVersion": "64784:171450342:2470859:1791311214915.1577:1791311214915.1577"
    },
    "99458c3127348767b4c677c3050e6cd463f34e62c94c9f7f2cb58e1e41b46f00": {
      "manifestSha256": "b3f09e6c73b3d68fb892c2335ec9b51e2c6100a9464bf9be4719ef0687c5daec",
      "sourceIdentitySha256": "d8dde1688ded1a5f7f8ea73c84a2ee5b607b7a1b69866b4eb3f99ed11eff0702",
      "sourceVersion": "64784:171450431:14609821:1791362132774.193:1791362132789.1934"
    },
    "9abae6e4f20fcfc81d9964efeccd32e6d771414bcfcd822f23bb87dd1cac1c10": {
      "manifestSha256": "a72fa5cb6b31d56c8176df4b5787535a0d2dc3a51b2c710f653e2be8f54fb1f0",
      "sourceIdentitySha256": "05f2a1d4a5a37f21d5769e131669360a0d8a3ba4f3e851c0f2fa075c718dc193",
      "sourceVersion": "64784:171450433:15562393:1791362367352.08:1791362367372.0803"
    },
    "9ccaf9bf8bac8cf302eaf5cbe1da42bec3c5307eca0a425ea05ef98df44e1fb1": {
      "manifestSha256": "1fdc9312f8efddfe4bcf56dd9cc823794c5564cb9521583f0470407266ed21d1",
      "sourceIdentitySha256": "471c162e033eb4947cbd0c683e2e44706e08c36437c67713421c082116a640e1",
      "sourceVersion": "64784:171450377:10220487:1791315891577.7466:1791315891590.7468"
    },
    "9db5e671c3166a68e4c2de6890bd4cda0bd17b5841761471d2b159369ad0256c": {
      "manifestSha256": "a07083b434a479a96d37ac6a43b19345ae34834009bdf5eee74cd0cf67356a56",
      "sourceIdentitySha256": "1781cba04ecdba972d74ddfe168b51f150f6e547267e65b516b51ecdeffb7443",
      "sourceVersion": "64784:171442469:43783:1782875085000:1790258147166.2507"
    },
    "a484a3ea2c2209273bc58e46909b362cadcc07ecb9ad45d178781954c7da4710": {
      "manifestSha256": "bd12480dcbf6cba8661c64ca46569d3cb44d7c39721b2f8db34c80cb378c6fc0",
      "sourceIdentitySha256": "80208fb85f81672cec04ccba09f090a6c71f9e3b3ea785f6a9c02a0eb49d61e6",
      "sourceVersion": "64784:171450403:19512654:1791318775968.4973:1791318775986.4976"
    },
    "a7278dc832a3ae743d8f4779a30817e7bc0c08b3c4f80715856a5e8f2aeffc53": {
      "manifestSha256": "7b468ef5a8936f944a724c74dcbe9d6a7916e072ecf52f63fd51d68e7198bbd8",
      "sourceIdentitySha256": "b84ef67e66c6d1df3127652d19f876c93c23816e184534b024a2e58cc32433ae",
      "sourceVersion": "64784:171450445:16558385:1791365366044.9158:1791365366066.916"
    },
    "abfbb313ddfcca51e533a32b3be8198a1546173d8e390976702b1c5c8befcba4": {
      "manifestSha256": "7f2dc7bb4439fdaca34a5d401856f03c0dd1ac163878d73b83e6dbf5fd7bbe1e",
      "sourceIdentitySha256": "1b87d2a09138969ab8ef23ecc5a4fa35aba4fd524c8312c90f31b01a6acf4c4a",
      "sourceVersion": "64784:171449755:141919:1791046445522.701:1791046445522.701"
    },
    "b0b15e4b77740449ad0ef47011b2937876fb0d8d5ae5f2fe2b81b5b49cfc9bce": {
      "manifestSha256": "75a415e2091beb932a75d5e6bb888f624e8aa481874d3fb7cb7d65e76f88d4ff",
      "sourceIdentitySha256": "f12b199f67f9b57b3e81c7cfa432c998c9c6a3170d2f20518066f3eb4ca58a5b",
      "sourceVersion": "64784:171450336:9886234:1791308079273.8013:1791308079284.8015"
    },
    "b31c935b27a582ea8a2eb3dfbb46c6aa1b669334069aabd1dd97baf118376362": {
      "manifestSha256": "6b65cc4c52d5fbf7eb2179077fd6646c275a539147469a175eb1002150b744f7",
      "sourceIdentitySha256": "c0cff8c460d180e0f273668e642b4462ebf6cc35295f2231058494061620c3e9",
      "sourceVersion": "64784:171450340:10819045:1791308641597.3835:1791308641610.3835"
    },
    "b544d579e199a2101b42a4b89818819e9c4dcd7e597397d3320e65c131b30fbe": {
      "manifestSha256": "39263f75d2d7e5745bd7a42d07eb3eb43bff5261e89ae2598b7df744736fafa5",
      "sourceIdentitySha256": "ed41ee66f4e87b82e2993c83c2c7978c37e3f078bc22880049d5ae5265193037",
      "sourceVersion": "64784:171450429:14479176:1791362026262.3364:1791362026275.3364"
    },
    "bbef06ab93ed1c4d02130a908a9d9094e03378e9783d54f71ff75c74746c4592": {
      "manifestSha256": "c0b1f8ac3b31e7eff44975c604fc3ba2554bf5c10a2eafbf73cc64414de327fd",
      "sourceIdentitySha256": "b2f2905fc264a401797ed6398186df9e370519e7e4c07ce0572adfc8a6a4761c",
      "sourceVersion": "64784:171450459:8476080:1791368453568.864:1791368453580.864"
    },
    "bceb1cc69d63016f3b5cf993e745182e17e516facf9cb22f90c894f64c85947b": {
      "manifestSha256": "bfb8fe840504bcd807f67831bfdc5a37207a0a0f8b0b494c7516fabe3e74b312",
      "sourceIdentitySha256": "279eea07ac117050b42ce1dec833b6ddbaf6f5a2fcee617175cee51c0e9dc159",
      "sourceVersion": "64784:171450328:29166:1791306596097.0808:1791306596097.0808"
    },
    "bf4ee17234030c3d79cf3b824bbc3e1632b5d5f6c943ac0fa1e21ce2462be2a9": {
      "manifestSha256": "bd13abc930fdcb5d029a589b88f7f9ace39baccf4d4cda81f221b202631ae8e9",
      "sourceIdentitySha256": "54560f7d7ad78a7c038d35e67979c5460dc13085ddbe56f7e8993c164ee0a329",
      "sourceVersion": "64784:171450441:14964770:1791364844780.7542:1791364844795.7542"
    },
    "c2b75707f30e24c0a3575940f27bfac6643461fe35404d5ac490a302e4f1b539": {
      "manifestSha256": "c600a9bd24fccb2da20ab4010513ed4aa924cff7367da3c1153ce4900012f421",
      "sourceIdentitySha256": "ad60b5d034fa099908b6269b8c461bb2d36d7bb00e1ebfc6db8b2eb8228ed50d",
      "sourceVersion": "64784:171450364:1333118:1791314720408.5464:1791314720408.5464"
    },
    "ce232d320af03f2d9949a0064acd8116faf289fdf598942b218c964d5abe921f": {
      "manifestSha256": "1d5da42fe7b18d4d70201550c0349563ba40cbb42dea5f53aea23fe3c5920561",
      "sourceIdentitySha256": "3e228f6c3f608978c6a6081c1f299f9e8ff5408b711f20c3ee9dc91dd6a0f382",
      "sourceVersion": "64784:171450379:18410700:1791316078354.2224:1791316078375.2227"
    },
    "d3981a15d73048ace30ccb7629cbb8ca186105eacd68f504cb780777793c7d0b": {
      "manifestSha256": "011197e8f9beb32de9071fbd9769b232ff38b0ab8ca2600796049ef0d6250920",
      "sourceIdentitySha256": "fcd78632b7d29fc565703f812d7fed1aaa182d026fb1b047a637615dbcab3e5d",
      "sourceVersion": "64784:171450447:8954893:1791365619770.947:1791365619781.9473"
    },
    "eb2eeff7f7a7a0c040ec6b2de24b83d0c08ccdb9ab2e33356be86072869ecfd4": {
      "manifestSha256": "06949909757315c40caeb713eb281428e19cc2ab173e8edc02af3fec96972ed3",
      "sourceIdentitySha256": "9497d4c610287d9fe749bb5e8beafb5af68a754a0b89491474c1fd97f6a9b569",
      "sourceVersion": "64784:171450385:16403741:1791316561806.0532:1791316561822.0532"
    },
    "f0095fa23a7be835451528a0f0549f6707e0a3f590c711730aaa79fdc5056ee3": {
      "manifestSha256": "7c928852ddd78f666d54e690339549e5c2ac2ad2c8e0fa23471dbc373e90dc5b",
      "sourceIdentitySha256": "8b3c67d6e6c6627b1a963321f197098e443095339a2d05a10691d246d657a44b",
      "sourceVersion": "64784:171450375:3252247:1791315638519.747:1791315638519.747"
    },
    "f6d903c772e3fcde3ba90ead7f79701bc35380312393b0f18d3162159cd5431e": {
      "manifestSha256": "44e09cc0436ccc3bd5e1077b8b1b95c3824eccd2d5f3d6d5addb4a565c4222f7",
      "sourceIdentitySha256": "92d79fc18e57df9f4445dbcce137628308b425a5faaf7266c242583f72797c62",
      "sourceVersion": "64784:171450405:19158300:1791318924121.628:1791318924137.628"
    },
    "f85a111b34e96ff739ebed788e47f5b4758091046887ce5a61b49be7686fd8d1": {
      "manifestSha256": "5426548fb3d656b36cec8297e984dc84ee9f9dbecfa2a6f1bf9f5514ef24f709",
      "sourceIdentitySha256": "e3b9b448b6a53e840433569f6befda8270363528386e6a070646a40fb4aa99bd",
      "sourceVersion": "64784:171450453:13825034:1791366783166.3447:1791366783188.345"
    },
    "fa62335a2166174d26523dda260b44f9b5958651b6e8695b972268b8e13b6146": {
      "manifestSha256": "2eddf6a30136f0c24c5c849304f8c7eb97c6a15a93634b3562d49756bf029760",
      "sourceIdentitySha256": "c0739fb43a5c74bbd361e9b0873841cec435a798515e4b732700e59223db0cd6",
      "sourceVersion": "64784:171450348:10986620:1791311628075.3335:1791311628088.3337"
    },
    "fbe0e091f229a397bbaccbe5a66147756d64fac803a874f82423576f2a93698f": {
      "manifestSha256": "5212738ffe795dc7165e412a49171619558648655cc4720e5a086a3297082b40",
      "sourceIdentitySha256": "5ce6e9cf7bbdd7afadbc1777564f8b1558aaaf786d0e3802371bfa506b944890",
      "sourceVersion": "64784:171450423:15955436:1791361114138.8965:1791361114171.8967"
    },
    "fe76ef581479152caa1bf9fa944f0f50638a7f0b691b1a7c38a9733d56b53341": {
      "manifestSha256": "683352da0418e08a8331cdf5d187dda409321902daa452805e55932cca626325",
      "sourceIdentitySha256": "f085053d9ea54f694b6f9b949b60e2ddec37bc38938a3c4dc211ac3b43c2a368",
      "sourceVersion": "64784:171450421:12816403:1791361092248.7173:1791361092263.7173"
    },
    "ffd639402fafbf2347b9abb0cc51db321ed7c0be704c307fb152c8d8243603a5": {
      "manifestSha256": "8c396be2d3e65ad063f3f3156566cd20cdc5340f7505eefb00e5f27bcbbe2a28",
      "sourceIdentitySha256": "2048722a2484330f1d87871de5a13bea46b843b2de02d45e66fad477beb04a8d",
      "sourceVersion": "64784:171450397:17776811:1791317858178.3425:1791317858195.3428"
    }
  }
});

// Separately approved immutable old versions. These are preserved history,
// never candidates for reuse under the current source identity.
export const APPROVED_HD_HISTORICAL_VERSIONS = freeze({
  "schema": "hd-historical-versions-approval-v1",
  "inventorySha256": "934df1fe2bbd9ed22d3ad070f4f3e88414877adbc6225fe878c16daf5e8daf85",
  "inventorySchema": "hd-historical-version-inventory-v1",
  "observedAt": "2026-10-19T18:42:14.413Z",
  "canonicalRoot": "/data/video-api-debugger/var-lib/storage/hd-derivatives",
  "binding": {
    "dev": "64784",
    "ino": "171598992"
  },
  "count": 11,
  "entries": {
    "0392df976a220ee1b88c1f49f6153ce9600e53e4a991eb5cc191046234959ed5": {
      "key": "0392df976a220ee1b88c1f49f6153ce9600e53e4a991eb5cc191046234959ed5",
      "manifestSha256": "b52be9ed177aa424808ce54b17494773aa4b09472ec1889d9e3c879752ae56b5",
      "status": "skipped",
      "reason": "source_changed",
      "historicalVersion": "64784:171451381:16136431:1792212230244.7507:1792212230259.751",
      "currentVersion": "64784:171451384:16136431:1792227255838.533:1792227255854.533",
      "historicalKeyMatches": true,
      "currentKey": "c1ddf5eac04800971c1b4298fd2d5b448655fb474874268d2231e9037f6f0b3f",
      "sourceIdentitySha256": "6306e4d6e1c5ec27d4bdf228d8e92b828fc20e4f3dba1ae2101a1a6ced6137c2",
      "currentSource": {
        "dev": "64784",
        "ino": "171451384",
        "bytes": 16136431,
        "mtimeMs": 1792227255838.533,
        "ctimeMs": 1792227255854.533
      },
      "output": null
    },
    "0d25b0d0367e15f41ba5c76fab1319100e766d0b60f9c738139e906facf9c069": {
      "key": "0d25b0d0367e15f41ba5c76fab1319100e766d0b60f9c738139e906facf9c069",
      "manifestSha256": "eecda35d29090cd36570208b7e71c68acd4b5108cd0fb2471a828432fac3ebec",
      "status": "ready",
      "reason": null,
      "historicalVersion": "64784:171451286:7248438:1792076185928.1643:1792076185938.1643",
      "currentVersion": "64784:171451316:7248438:1792081360406.0596:1792081360427.0598",
      "historicalKeyMatches": true,
      "currentKey": "1e77c7790445b3a005418257f1761441a47ddeb5536e2990d953340f13d7ef75",
      "sourceIdentitySha256": "a6b94a382c67afc1a4a84c1fe1dac604587af53f60a5da6c45d476b94b54b62c",
      "currentSource": {
        "dev": "64784",
        "ino": "171451316",
        "bytes": 7248438,
        "mtimeMs": 1792081360406.0596,
        "ctimeMs": 1792081360427.0598
      },
      "output": {
        "bytes": 1262012,
        "lengthMatches": true,
        "dev": "64784",
        "ino": "171605268",
        "mtimeMs": 1792076297760.0483,
        "ctimeMs": 1792076298580.0547,
        "width": 2048,
        "height": 2048,
        "integrity": "hd-output-integrity-v2",
        "failedChecks": []
      }
    },
    "246f13b3594ad3f12355e9efbc89213d163fa05c7436aed83f4e9ff0d30dcea5": {
      "key": "246f13b3594ad3f12355e9efbc89213d163fa05c7436aed83f4e9ff0d30dcea5",
      "manifestSha256": "6cff942e807b6795ad52f8fce1ab78320f84b3ab71687c627f57fbeb6ea8afc6",
      "status": "ready",
      "reason": null,
      "historicalVersion": "64784:171451152:9988339:1791994164850.3472:1791994164861.3472",
      "currentVersion": "64784:171451154:9988339:1791995696647.4104:1791995696656.4104",
      "historicalKeyMatches": true,
      "currentKey": "f8207dfef608d58ce494438ea43bdf325c6570de971344319ac54ba8ac4d8290",
      "sourceIdentitySha256": "d9e050173a31999059298b4c6605c4b43be6c9c86ed0c04992d35b82dfbf5819",
      "currentSource": {
        "dev": "64784",
        "ino": "171451154",
        "bytes": 9988339,
        "mtimeMs": 1791995696647.4104,
        "ctimeMs": 1791995696656.4104
      },
      "output": {
        "bytes": 1466679,
        "lengthMatches": true,
        "dev": "64784",
        "ino": "171604895",
        "mtimeMs": 1791994229151.854,
        "ctimeMs": 1791994238456.9275,
        "width": 2048,
        "height": 2048,
        "integrity": "hd-output-integrity-v2",
        "failedChecks": []
      }
    },
    "54808a2628459a95f98506cb1c2fb3de3bd4e44af723b5178dc82daf44668796": {
      "key": "54808a2628459a95f98506cb1c2fb3de3bd4e44af723b5178dc82daf44668796",
      "manifestSha256": "8d911188013d026fbf0131a07fc97c8a24f8b9fc0aa272c33af91c9a66552906",
      "status": "ready",
      "reason": null,
      "historicalVersion": "64784:171451154:9988339:1791994761883.0542:1791994761896.0544",
      "currentVersion": "64784:171451154:9988339:1791995696647.4104:1791995696656.4104",
      "historicalKeyMatches": true,
      "currentKey": "f8207dfef608d58ce494438ea43bdf325c6570de971344319ac54ba8ac4d8290",
      "sourceIdentitySha256": "d9e050173a31999059298b4c6605c4b43be6c9c86ed0c04992d35b82dfbf5819",
      "currentSource": {
        "dev": "64784",
        "ino": "171451154",
        "bytes": 9988339,
        "mtimeMs": 1791995696647.4104,
        "ctimeMs": 1791995696656.4104
      },
      "output": {
        "bytes": 1466679,
        "lengthMatches": true,
        "dev": "64784",
        "ino": "171604907",
        "mtimeMs": 1791994844226.7034,
        "ctimeMs": 1791994847484.7292,
        "width": 2048,
        "height": 2048,
        "integrity": "hd-output-integrity-v2",
        "failedChecks": []
      }
    },
    "5c82ddeabc9ac6d76a589f3b345b8785f796f42ad8d18c925ec0854177c0d037": {
      "key": "5c82ddeabc9ac6d76a589f3b345b8785f796f42ad8d18c925ec0854177c0d037",
      "manifestSha256": "98cb2d192bef8be5dd910367965ab0d4f1dcc2665a3bf8f0540e4e924c92a3b6",
      "status": "ready",
      "reason": null,
      "historicalVersion": "64784:171451148:9259945:1791988204162.8801:1791988204175.8804",
      "currentVersion": "64784:171451150:9259945:1791989204457.7957:1791989204469.7957",
      "historicalKeyMatches": true,
      "currentKey": "9bdca327aefa55d2c1663d4f7553fad4f5a9e614e76c90470ea3014e9e043f1d",
      "sourceIdentitySha256": "d891cf1ffdf35742382eedcc01d4c4a9b1aefc26d677146bed0a56a2272b3abe",
      "currentSource": {
        "dev": "64784",
        "ino": "171451150",
        "bytes": 9259945,
        "mtimeMs": 1791989204457.7957,
        "ctimeMs": 1791989204469.7957
      },
      "output": {
        "bytes": 1303693,
        "lengthMatches": true,
        "dev": "64784",
        "ino": "171604861",
        "mtimeMs": 1791988287733.5444,
        "ctimeMs": 1791988288526.5508,
        "width": 2048,
        "height": 2048,
        "integrity": "hd-output-integrity-v2",
        "failedChecks": []
      }
    },
    "6318e6b6eb3c082cbab63f4a906a4411de84c2e685f55cfbda9033c6ffecfe83": {
      "key": "6318e6b6eb3c082cbab63f4a906a4411de84c2e685f55cfbda9033c6ffecfe83",
      "manifestSha256": "fb077651419763610bc8679ccbb45ba4f2cd1baeb1c2c3ea301a51cda5bc3ae3",
      "status": "skipped",
      "reason": "source_changed",
      "historicalVersion": "64784:171451153:9988339:1791995668713.1907:1791995668723.191",
      "currentVersion": "64784:171451154:9988339:1791995696647.4104:1791995696656.4104",
      "historicalKeyMatches": true,
      "currentKey": "f8207dfef608d58ce494438ea43bdf325c6570de971344319ac54ba8ac4d8290",
      "sourceIdentitySha256": "d9e050173a31999059298b4c6605c4b43be6c9c86ed0c04992d35b82dfbf5819",
      "currentSource": {
        "dev": "64784",
        "ino": "171451154",
        "bytes": 9988339,
        "mtimeMs": 1791995696647.4104,
        "ctimeMs": 1791995696656.4104
      },
      "output": null
    },
    "7a6796db7e1795b6e74ed0b407b2b274e6008e8a1d3765d15d2a092d12aa0ecd": {
      "key": "7a6796db7e1795b6e74ed0b407b2b274e6008e8a1d3765d15d2a092d12aa0ecd",
      "manifestSha256": "c1a4ed40fe1a04704f86551ba80eadfaec889a4cc55f58f8f550fc32a1ece351",
      "status": "skipped",
      "reason": "source_changed",
      "historicalVersion": "64784:171451299:9752341:1792078890891.5298:1792078890903.5298",
      "currentVersion": "64784:171451302:9752341:1792078907708.6628:1792078907719.6628",
      "historicalKeyMatches": true,
      "currentKey": "4ba8d4182fb75355ed98e05757c32f5fbd54b45395d268ba66c8985c9ff3627e",
      "sourceIdentitySha256": "0fcabe539b8d8342a64f2346bbd406a28eabbedba3281b053ce2fb873bf03baf",
      "currentSource": {
        "dev": "64784",
        "ino": "171451302",
        "bytes": 9752341,
        "mtimeMs": 1792078907708.6628,
        "ctimeMs": 1792078907719.6628
      },
      "output": null
    },
    "83178e47de4546b038441f40e13c83f5710085babd5c3916cf65dfa7a2649282": {
      "key": "83178e47de4546b038441f40e13c83f5710085babd5c3916cf65dfa7a2649282",
      "manifestSha256": "d837aa2b5a476bc8ef353f1d5c2eff43e9c7ae8c0fdd2174ee6310068a092bf4",
      "status": "ready",
      "reason": null,
      "historicalVersion": "64784:171451382:16136431:1792212367429.374:1792212367445.3743",
      "currentVersion": "64784:171451384:16136431:1792227255838.533:1792227255854.533",
      "historicalKeyMatches": true,
      "currentKey": "c1ddf5eac04800971c1b4298fd2d5b448655fb474874268d2231e9037f6f0b3f",
      "sourceIdentitySha256": "6306e4d6e1c5ec27d4bdf228d8e92b828fc20e4f3dba1ae2101a1a6ced6137c2",
      "currentSource": {
        "dev": "64784",
        "ino": "171451384",
        "bytes": 16136431,
        "mtimeMs": 1792227255838.533,
        "ctimeMs": 1792227255854.533
      },
      "output": {
        "bytes": 1889586,
        "lengthMatches": true,
        "dev": "64784",
        "ino": "171605691",
        "mtimeMs": 1792212547595.1865,
        "ctimeMs": 1792212553124.23,
        "width": 3840,
        "height": 2160,
        "integrity": "hd-output-integrity-v2",
        "failedChecks": []
      }
    },
    "ee7c417ab4f7ccb29dfbb14bc45ef3917cfd41737df363307c480d7a2acb616a": {
      "key": "ee7c417ab4f7ccb29dfbb14bc45ef3917cfd41737df363307c480d7a2acb616a",
      "manifestSha256": "7fd79026c6ee2e692b84deb3348cd9e9279d6be8e4e689ef8451081082fdbb47",
      "status": "ready",
      "reason": null,
      "historicalVersion": "64784:171451284:7350546:1792075806463.1648:1792075806473.1648",
      "currentVersion": "64784:171451292:7350546:1792077775113.73:1792077775124.7302",
      "historicalKeyMatches": true,
      "currentKey": "65825d644e92d6fa78f24825e9a763a212386a19d9a1834eab1f0db46370e0b1",
      "sourceIdentitySha256": "02dae775c453e1dfc41a681e33c0c0e3006efba43cc87126dbfa8befca61a785",
      "currentSource": {
        "dev": "64784",
        "ino": "171451292",
        "bytes": 7350546,
        "mtimeMs": 1792077775113.73,
        "ctimeMs": 1792077775124.7302
      },
      "output": {
        "bytes": 1333645,
        "lengthMatches": true,
        "dev": "64784",
        "ino": "171605253",
        "mtimeMs": 1792075891425.8364,
        "ctimeMs": 1792075892040.8413,
        "width": 2048,
        "height": 2048,
        "integrity": "hd-output-integrity-v2",
        "failedChecks": []
      }
    },
    "ef230cbe933d6952275c3808379071b040c3767a209777ffb019679185a8a11e": {
      "key": "ef230cbe933d6952275c3808379071b040c3767a209777ffb019679185a8a11e",
      "manifestSha256": "30e7ed1a2f2b97d7497a3a2b7dbc222af046da372a56e50f810b49a034e7e344",
      "status": "skipped",
      "reason": "source_changed",
      "historicalVersion": "64784:171451318:7395643:1792081099936.0022:1792081099948.0022",
      "currentVersion": "64784:171451317:7395643:1792081157739.4587:1792081157748.4587",
      "historicalKeyMatches": true,
      "currentKey": "a3fbd07fd848844a25fb2eff3ed10408b26cf966b7588098efa54d33d83ec9c2",
      "sourceIdentitySha256": "da30e0cf2bdc763c26df282c2e6eda4c8e11e069594150c0b87370ef6ea2c6c3",
      "currentSource": {
        "dev": "64784",
        "ino": "171451317",
        "bytes": 7395643,
        "mtimeMs": 1792081157739.4587,
        "ctimeMs": 1792081157748.4587
      },
      "output": null
    },
    "fd4fcc2497ac5fac83b8ac88e62a39b10404fadfa2b3fc498b4b7ad7ce974b72": {
      "key": "fd4fcc2497ac5fac83b8ac88e62a39b10404fadfa2b3fc498b4b7ad7ce974b72",
      "manifestSha256": "93612a7a6d8ebe1eff518b193ec8b8180d2fa36c3e89643d2cd264df505b30d6",
      "status": "ready",
      "reason": null,
      "historicalVersion": "64784:171451316:7395643:1792080708328.907:1792080708336.907",
      "currentVersion": "64784:171451317:7395643:1792081157739.4587:1792081157748.4587",
      "historicalKeyMatches": true,
      "currentKey": "a3fbd07fd848844a25fb2eff3ed10408b26cf966b7588098efa54d33d83ec9c2",
      "sourceIdentitySha256": "da30e0cf2bdc763c26df282c2e6eda4c8e11e069594150c0b87370ef6ea2c6c3",
      "currentSource": {
        "dev": "64784",
        "ino": "171451317",
        "bytes": 7395643,
        "mtimeMs": 1792081157739.4587,
        "ctimeMs": 1792081157748.4587
      },
      "output": {
        "bytes": 1364951,
        "lengthMatches": true,
        "dev": "64784",
        "ino": "171605378",
        "mtimeMs": 1792080797562.613,
        "ctimeMs": 1792080798173.618,
        "width": 2048,
        "height": 2048,
        "integrity": "hd-output-integrity-v2",
        "failedChecks": []
      }
    }
  }
});
