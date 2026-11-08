import type { Dimension } from './engine';
import { CONFIG } from './vocabulary';

// English counterparts of the approved optional designs. Custom labels stay verbatim.
const details: Partial<Record<Dimension, string[]>> = {
  equipment: ['a reversible umbrella shield and flotation capsule', 'a folding tail tool and ruler workbench', 'a magnetic double-ended tool hammer', 'a guided signal slingshot with a return track', 'a rhythmic shoulder counter', 'a telescoping wrist key for layered mechanisms', 'a portable lighthouse and storm-survey instrument', 'suction footwear with reversible climbing pads', 'a folding navigation map at the tail', 'a reversible lid and travel plate', 'a jointed direction-finding staff', 'a three-part telescoping carrier'],
  signature: ['a small worn notch in the left silhouette', 'two shallow repaired shoulder marks', 'one shortened tooth-shaped structure', 'unequal short horns', 'a star-shaped patch around the eye', 'a neat stitched waist patch', 'a polished and worn handgrip', 'contrasting original material on one glove or grip', 'a naturally notched eyebrow panel', 'an old connector ring at the tail tip', 'a faded matte protective layer', 'slightly different forelimb proportions'],
  entity: ['two partners forming one circular silhouette', 'large and small partners sharing a protective shell', 'a character and floating assistant linked by a tether', 'an upper observer cooperating with a lower moving body', 'separable navigation and protection partners', 'three small units forming one moving device', 'a small character nested in a protective capsule', 'a character and mirrored helper with opposite motions', 'a rider and vehicle sharing a detachable axle', 'a two-sided character with distinct controls', 'two minds alternately operating one mechanism', 'mirrored partners with complementary linked parts'],
  physique: ['a broad upper body tapering into short legs', 'a low center of gravity and barrel-shaped base', 'long limbs and a compact torso', 'a large head and short limbs', 'a soft teardrop-shaped body', 'an inverted-triangle upper body', 'a large continuous round belly', 'a rounded tapering cone', 'a balanced asymmetric shoulder silhouette', 'a slender torso with broad grounded feet', 'wide shoulders and compact feet', 'a spherical main body and short functional limbs'],
};
export function englishDetail(id: Dimension, label: string) {
  const index = (CONFIG.find(c => c.id === id)!.tags as readonly string[]).indexOf(label);
  return index < 0 ? label : details[id]?.[index] || label;
}
