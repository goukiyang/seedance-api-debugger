import type { Dimension } from './engine';
import { CONFIG, DETAIL_ALTS } from './vocabulary';

// Each pair translates the same legacy/alternate detail chosen in the Chinese prompt.
const details: Partial<Record<Dimension, [string, string][]>> = {
  equipment: [
    ['a reverse umbrella shield', 'a shoulder shield that flips into a flotation rescue capsule'],
    ['a folding tail tool', 'a ruler repair bench unfolding from the waist'],
    ['a magnetic double-headed hammer', 'a soft-edged tool hammer with gear-synchronized ends'],
    ['a postmark slingshot', 'a slingshot launching colored beacons along a tail-ring track'],
    ['buttons that count', 'a shoulder counter that lights up with each footstep'],
    ['an extendable key ring', 'a wrist key that rotates open layered mechanisms'],
    ['a backpack lighthouse', 'a wrist-mounted folding storm survey instrument'],
    ['octopus suction shoes', 'reversible springy climbing pads beneath the feet'],
    ['a map-scroll whip', 'a folding direction finder attached to the tail'],
    ['a reversible pot lid', 'a portable cover that becomes a travel plate'],
    ['a weather-vane spear', 'a jointed two-part staff that measures direction'],
    ['a transforming fishing rod', 'a three-part telescoping hanger springing from a pocket'],
  ],
  signature: [
    ['a notched ear', 'a small left-side silhouette notch from an old collision'],
    ['a shallow cheek scar', 'two shallow repaired shoulder marks'],
    ['half a front tooth missing', 'one tooth-shaped structure shorter than its counterpart'],
    ['asymmetric short horns', 'slightly unequal lengths of horn-like structures'],
    ['a star-shaped patch around the eye', 'an eye-area patch echoing the surface pattern'],
    ['patchwork stitching', 'a neat, visible stitched repair patch at the waist'],
    ['a worn shoulder guard', 'a frequently used grip worn smooth'],
    ['mismatched colored gloves', 'a right-side grip retaining a different original material color'],
    ['a notched eyebrow', 'a natural notch in one curved eyebrow panel'],
    ['a knot at the tail tip', 'an old connector ring around the tail tip'],
    ['faded scales', 'a faded matte patch on the outer protective plate'],
    ['one long and one short arm', 'slightly different forelimb volume proportions'],
  ],
  entity: [
    ['fused twins', 'two small partners joining into one circular silhouette'],
    ['two symbiotic characters', 'large and small partners cooperating through a shared back shell'],
    ['a main character and satellite partner', 'a character and floating assistant sharing a tether'],
    ['cooperating upper and lower body halves', 'an upper observer cooperating with a lower moving body'],
    ['a separable duo', 'two separable partners handling navigation and protection'],
    ['three split bodies recombining', 'three small units combining into one moving device'],
    ['parent-and-child nesting forms', 'a small character nested in a large circular protective capsule'],
    ['an opposite shadow partner', 'a character and mirrored helper coordinating opposite motions'],
    ['a character and mount sharing one body', 'a character and vehicle sharing a detachable axle'],
    ['a two-sided character', 'distinct control interfaces on the front and back of one body'],
    ['two minds in one body', 'two minds alternately operating one shell mechanism'],
    ['mirrored siblings', 'two visually related partners with complementary linked parts'],
  ],
  physique: [
    ['a large upper body and small lower body', 'large shoulder volumes tapering into the legs'],
    ['a low, barrel-shaped body', 'a solid lower body and short torso forming a stable base'],
    ['long legs and a short torso', 'long slender limbs connected to a compact round torso'],
    ['short limbs and a large head', 'an oversized head and short straight limbs creating an exaggerated rhythm'],
    ['a teardrop-shaped body', 'a soft water-drop silhouette, round above and tapered below'],
    ['an inverted-triangle upper body', 'a stable triangular mass, broad above and narrow below'],
    ['a large round belly', 'one large continuous round belly dominating the body'],
    ['a cone-shaped body', 'layered, progressively tapering rounded cone volumes'],
    ['an asymmetric left-right silhouette', 'one wider shoulder with balanced weight distribution'],
    ['a light, slender form', 'an elongated torso with broad grounded feet'],
    ['very wide shoulders and narrow feet', 'laterally spread shoulders with compact feet'],
    ['a spherical main body', 'a large spherical torso with short functional limbs'],
  ],
};
export function englishDetail(id: Dimension, label: string, detail?: string) {
  const index = (CONFIG.find(c => c.id === id)!.tags as readonly string[]).indexOf(label);
  if (index < 0) return `an original structure inspired by ${label}`;
  const alternate = (DETAIL_ALTS as Record<string, string[]>)[id]?.[index] === detail;
  return details[id]?.[index]?.[alternate ? 1 : 0] || label;
}
