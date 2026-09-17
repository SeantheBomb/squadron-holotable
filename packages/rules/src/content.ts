// Built-in mechanical content with neutral, original naming. Presentation packs may overlay names,
// text and models at runtime (see client/src/pack.ts) without touching mechanics or ids.
import type { ActionDef, Content, DamageCardDef, PilotDef, ShipDef, UpgradeDef } from './types';

const W = (type: ActionDef['type'], linked?: ActionDef['linked']): ActionDef => ({ type, difficulty: 'W', linked });
const R = (type: ActionDef['type']): ActionDef => ({ type, difficulty: 'R' });

const ships: ShipDef[] = [
  {
    id: 'lancer', name: 'KR-7 Lancer', faction: 'coalition', size: 'small', mesh: 'lancer',
    dial: ['1BB', '1FB', '1NB', '2TW', '2BB', '2FB', '2NB', '2YW', '3ER', '3TW', '3BW', '3FW', '3NW', '3YW', '3RR', '4FW', '4KR'],
    attack: 3, agility: 2, hull: 4, shields: 2,
    actions: [W('focus'), W('lock'), W('barrelRoll')],
  },
  {
    id: 'bulwark', name: 'HV-2 Bulwark', faction: 'coalition', size: 'small', mesh: 'bulwark',
    dial: ['1BB', '1FB', '1NB', '2TW', '2BW', '2FB', '2NW', '2YW', '3TR', '3BW', '3FW', '3NW', '3YR', '4FR', '4KR'],
    attack: 2, agility: 1, hull: 6, shields: 2,
    actions: [W('focus'), W('lock'), R('barrelRoll'), R('reload')],
  },
  {
    id: 'dart', name: 'Dart Interdictor', faction: 'dominion', size: 'small', mesh: 'dart',
    dial: ['1TW', '1YW', '2TW', '2BB', '2FB', '2NB', '2YW', '3TW', '3BW', '3FB', '3NW', '3YW', '3KR', '4FW', '4KR', '5FW'],
    attack: 2, agility: 3, hull: 3, shields: 0,
    actions: [W('focus'), W('evade'), W('barrelRoll')],
  },
  {
    id: 'stiletto', name: 'Stiletto Mk I', faction: 'dominion', size: 'small', mesh: 'stiletto',
    dial: ['1BB', '1FW', '1NB', '2TW', '2BB', '2FB', '2NB', '2YW', '3ER', '3TW', '3BW', '3FB', '3NW', '3YW', '3RR', '4FW', '4KR', '5FW'],
    attack: 2, agility: 3, hull: 3, shields: 2,
    actions: [W('focus', { type: 'barrelRoll', difficulty: 'R' }), W('lock'), W('barrelRoll')],
    shipAbility: { id: 'atc', name: 'Predictive Targeting', text: 'While you perform a primary attack against a defender you have locked, roll 1 additional attack die and you may change 1 hit to a critical hit.' },
  },
];

const P = (p: PilotDef): PilotDef => p;
const pilots: PilotDef[] = [
  // Lancer
  P({ id: 'lancer-escort', shipId: 'lancer', name: 'Azure Flight Escort', initiative: 2, limited: 0, cost: 5, loadout: 4, slots: ['Astromech'] }),
  P({ id: 'lancer-veteran', shipId: 'lancer', name: 'Crimson Flight Veteran', initiative: 3, limited: 0, cost: 5, loadout: 3, slots: ['Talent', 'Astromech'] }),
  P({ id: 'lancer-shepherd', shipId: 'lancer', name: '"Shepherd"', caption: 'Crimson Leader', initiative: 4, limited: 1, cost: 5, loadout: 16, slots: ['Talent', 'Torpedo', 'Astromech', 'Modification'], ability: 'shareFocus', text: 'After you spend a focus token, you may choose a friendly ship at range 1-3. That ship gains 1 focus token.' }),
  P({ id: 'lancer-prodigy', shipId: 'lancer', name: '"Prodigy"', caption: 'Crimson Five', initiative: 5, limited: 1, cost: 6, loadout: 24, slots: ['Talent', 'Torpedo', 'Astromech', 'Modification', 'Force Power'], force: { value: 2, recovers: 1 }, ability: 'defenderRecoverForce', text: 'After you become the defender (before dice are rolled), you may recover 1 force.' }),
  P({ id: 'lancer-deadeye', shipId: 'lancer', name: '"Deadeye"', caption: 'Crimson Two', initiative: 6, limited: 1, cost: 5, loadout: 9, slots: ['Talent', 'Talent', 'Torpedo', 'Astromech', 'Modification'], ability: 'minusDefenseDie', text: 'While you perform an attack, the defender rolls 1 fewer defense die.' }),
  P({ id: 'lancer-prodigy-sl', shipId: 'lancer', name: '"Prodigy"', caption: 'Standard Loadout', initiative: 5, limited: 1, cost: 6, loadout: 0, slots: [], force: { value: 2, recovers: 1 }, ability: 'defenderRecoverForce', text: 'After you become the defender (before dice are rolled), you may recover 1 force.', standardLoadout: ['instinctive-aim', 'heavy-torpedoes', 'ace-droid'] }),
  // Bulwark
  P({ id: 'bulwark-bomber', shipId: 'bulwark', name: 'Slate Flight Bomber', initiative: 2, limited: 0, cost: 4, loadout: 8, slots: ['Missile', 'Modification'] }),
  P({ id: 'bulwark-veteran', shipId: 'bulwark', name: 'Amber Flight Veteran', initiative: 3, limited: 0, cost: 4, loadout: 6, slots: ['Turret', 'Missile', 'Modification'] }),
  P({ id: 'bulwark-overseer', shipId: 'bulwark', name: '"Overseer"', caption: 'Slate Leader', initiative: 4, limited: 1, cost: 3, loadout: 7, slots: ['Turret', 'Torpedo', 'Astromech', 'Missile', 'Modification'], ability: 'rerollPerFriendNearDefender', text: 'While you perform an attack, you may reroll 1 attack die for each other friendly ship at range 0-1 of the defender.' }),
  P({ id: 'bulwark-bulldog', shipId: 'bulwark', name: '"Bulldog"', caption: 'Amber Nine', initiative: 5, limited: 1, cost: 5, loadout: 18, slots: ['Talent', 'Turret', 'Astromech', 'Modification'], ability: 'evadeIfEnemyClose', text: 'While you defend, if there is an enemy ship at range 0-1, add 1 evade result to your dice results.' }),
  // Dart
  P({ id: 'dart-cadet', shipId: 'dart', name: 'Academy Cadet', initiative: 1, limited: 0, cost: 2, loadout: 0, slots: [] }),
  P({ id: 'dart-pilot', shipId: 'dart', name: 'Onyx Wing Pilot', initiative: 2, limited: 0, cost: 2, loadout: 0, slots: [] }),
  P({ id: 'dart-ace', shipId: 'dart', name: 'Sable Wing Ace', initiative: 3, limited: 0, cost: 2, loadout: 0, slots: [] }),
  P({ id: 'dart-nightowl', shipId: 'dart', name: '"Nightowl"', caption: 'Onyx Two', initiative: 2, limited: 1, cost: 3, loadout: 4, slots: ['Talent', 'Talent'], ability: 'focusAfterBlue', text: 'After you fully execute a blue maneuver, you may perform a focus action.' }),
  P({ id: 'dart-baron', shipId: 'dart', name: '"Baron"', caption: 'Braggart', initiative: 3, limited: 1, cost: 3, loadout: 5, slots: ['Talent', 'Talent'], ability: 'actionAfterFriendDefends', text: 'After a friendly ship at range 0-1 defends (after damage is resolved), you may perform an action.' }),
  P({ id: 'dart-vulture', shipId: 'dart', name: '"Vulture"', caption: 'Inferno Two', initiative: 4, limited: 1, cost: 3, loadout: 12, slots: ['Talent', 'Talent', 'Missile', 'Modification'], ability: 'plusDieVsDamaged', text: 'While you perform an attack against a damaged defender, roll 1 additional attack die.' }),
  P({ id: 'dart-brawler', shipId: 'dart', name: '"Brawler"', caption: 'Sable Two', initiative: 5, limited: 1, cost: 3, loadout: 4, slots: ['Talent'], ability: 'plusDieRange1', text: 'While you perform an attack at attack range 1, roll 1 additional attack die.' }),
  P({ id: 'dart-needle', shipId: 'dart', name: '"Needle"', caption: 'Seasoned Veteran', initiative: 5, limited: 1, cost: 3, loadout: 3, slots: ['Talent'], ability: 'plusDieBullseye', text: 'While you perform an attack against a defender in your bullseye arc, roll 1 additional attack die.' }),
  P({ id: 'dart-packleader', shipId: 'dart', name: '"Packleader"', caption: 'Onyx Leader', initiative: 5, limited: 1, cost: 4, loadout: 8, slots: ['Talent', 'Talent', 'Modification'], ability: 'auraReroll', text: 'While a friendly ship at range 0-1 performs a primary attack, that ship may reroll 1 attack die.' }),
  // Stiletto
  P({ id: 'stiletto-pilot', shipId: 'stiletto', name: 'Gale Wing Pilot', initiative: 2, limited: 0, cost: 4, loadout: 4, slots: ['Sensor', 'Modification'] }),
  P({ id: 'stiletto-ace', shipId: 'stiletto', name: 'Squall Wing Ace', initiative: 3, limited: 0, cost: 4, loadout: 2, slots: ['Sensor', 'Talent', 'Modification'] }),
  P({ id: 'stiletto-comet', shipId: 'stiletto', name: '"Comet"', caption: 'Finest of the Fleet', initiative: 5, limited: 1, cost: 4, loadout: 8, slots: ['Talent', 'Sensor', 'Missile', 'Modification'], ability: 'redBoostAfterAction', text: 'After you perform an action, you may perform a red boost action.' }),
  P({ id: 'stiletto-warlord', shipId: 'stiletto', name: '"The Warlord"', caption: 'Sable Leader', initiative: 6, limited: 1, cost: 7, loadout: 21, slots: ['Sensor', 'Missile', 'Modification', 'Modification', 'Force Power', 'Force Power', 'Talent'], force: { value: 3, recovers: 1 }, ability: 'forceForAction', text: 'After you perform an action, you may spend 1 force to perform an action.' }),
  P({ id: 'stiletto-warlord-sl', shipId: 'stiletto', name: '"The Warlord"', caption: 'Standard Loadout', initiative: 6, limited: 1, cost: 6, loadout: 0, slots: [], force: { value: 3, recovers: 1 }, ability: 'forceForAction', text: 'After you perform an action, you may spend 1 force to perform an action.', standardLoadout: ['wrath', 'ion-missiles', 'afterburners'] }),
];

const U = (u: UpgradeDef): UpgradeDef => u;
const upgrades: UpgradeDef[] = [
  U({ id: 'heavy-torpedoes', name: 'Heavy Torpedoes', slot: 'Torpedo', cost: 12, limited: 0, charges: { value: 2, recovers: 0 }, attack: { arc: 'front', value: 4, minRange: 2, maxRange: 3, ordnance: true, requires: 'lock', chargeCost: 1 }, ability: 'hitToCrit', text: 'Attack (lock): Spend 1 charge. You may change 1 hit to a critical hit.' }),
  U({ id: 'ion-missiles', name: 'Ion Missiles', slot: 'Missile', cost: 4, limited: 0, charges: { value: 3, recovers: 0 }, attack: { arc: 'front', value: 3, minRange: 2, maxRange: 3, ordnance: true, requires: 'lock', ion: true, chargeCost: 1 }, text: 'Attack (lock): Spend 1 charge. If this attack hits, the defender suffers 1 damage; every other uncancelled result inflicts an ion token instead.' }),
  U({ id: 'ion-turret', name: 'Ion Turret', slot: 'Turret', cost: 5, limited: 0, attack: { arc: 'turret', value: 3, minRange: 1, maxRange: 2, ordnance: false, ion: true }, addActions: [W('rotate')], text: 'Turret attack. If it hits, the defender suffers 1 damage; every other uncancelled result inflicts an ion token instead.' }),
  U({ id: 'dorsal-turret', name: 'Dorsal Turret', slot: 'Turret', cost: 2, limited: 0, attack: { arc: 'turret', value: 2, minRange: 1, maxRange: 2, ordnance: false }, addActions: [W('rotate')], text: 'Turret attack.' }),
  U({ id: 'shield-upgrade', name: 'Shield Upgrade', slot: 'Modification', cost: 8, limited: 0, stat: { shields: 1 }, text: '+1 shield.' }),
  U({ id: 'hull-upgrade', name: 'Hull Upgrade', slot: 'Modification', cost: 6, limited: 0, stat: { hull: 1 }, text: '+1 hull.' }),
  U({ id: 'afterburners', name: 'Afterburners', slot: 'Modification', cost: 8, limited: 0, charges: { value: 2, recovers: 0 }, ability: 'afterburners', text: 'After you fully execute a speed 3-5 maneuver, you may spend 1 charge to perform a boost action, even while stressed.', restrictions: { sizes: ['small'] } }),
  U({ id: 'elusive', name: 'Elusive', slot: 'Talent', cost: 4, limited: 0, charges: { value: 1, recovers: 0 }, ability: 'elusive', text: 'While you defend, you may spend 1 charge to reroll 1 defense die. After you fully execute a red maneuver, recover 1 charge.' }),
  U({ id: 'predator', name: 'Predator', slot: 'Talent', cost: 3, limited: 0, ability: 'predator', text: 'While you perform a primary attack, if the defender is in your bullseye arc, you may reroll 1 attack die.' }),
  U({ id: 'marksmanship', name: 'Marksmanship', slot: 'Talent', cost: 1, limited: 0, ability: 'marksmanship', text: 'While you perform an attack, if the defender is in your bullseye arc, you may change 1 hit to a critical hit.' }),
  U({ id: 'crack-shot', name: 'Crack Shot', slot: 'Talent', cost: 4, limited: 0, charges: { value: 1, recovers: 0 }, ability: 'crackShot', text: 'While you perform a primary attack, if the defender is in your bullseye arc, before results are neutralized you may spend 1 charge to cancel 1 evade result.' }),
  U({ id: 'outmaneuver', name: 'Outmaneuver', slot: 'Talent', cost: 12, limited: 0, ability: 'outmaneuver', text: 'While you perform a front arc attack, if you are not in the defender\'s firing arc, the defender rolls 1 fewer defense die.' }),
  U({ id: 'fire-control', name: 'Fire-Control System', slot: 'Sensor', cost: 2, limited: 0, ability: 'fireControl', text: 'While you perform an attack, if you have a lock on the defender, you may reroll 1 attack die. If you do, you cannot spend your lock during this attack.' }),
  U({ id: 'instinctive-aim', name: 'Instinctive Aim', slot: 'Force Power', cost: 2, limited: 0, ability: 'instinctiveAim', text: 'While you perform a special attack, you may spend 1 force to ignore the focus or lock requirement.', restrictions: { needsForce: true } }),
  U({ id: 'evasive-insight', name: 'Evasive Insight', slot: 'Force Power', cost: 2, limited: 0, ability: 'brilliantEvasion', text: 'While you defend, if you are not in the attacker\'s bullseye arc, you may spend 1 force to change 2 focus results to evade results.', restrictions: { needsForce: true } }),
  U({ id: 'wrath', name: 'Wrath', slot: 'Force Power', cost: 5, limited: 0, ability: 'hate', text: 'After you suffer 1 or more damage, recover that many force.', restrictions: { needsForce: true } }),
  U({ id: 'field-droid', name: 'Field Repair Droid', slot: 'Astromech', cost: 6, limited: 0, charges: { value: 2, recovers: 0 }, ability: 'regenShield', text: 'After you reveal your dial, you may spend 1 charge and gain 1 disarm token to recover 1 shield.' }),
  U({ id: 'ace-droid', name: 'Veteran Repair Droid', slot: 'Astromech', cost: 0, limited: 1, charges: { value: 3, recovers: 0 }, ability: 'regenShield', text: 'After you reveal your dial, you may spend 1 charge and gain 1 disarm token to recover 1 shield.', restrictions: { standardLoadoutOnly: true } }),
  U({ id: 'salvage-droid', name: 'Salvage Droid', slot: 'Astromech', cost: 4, limited: 0, charges: { value: 2, recovers: 0 }, ability: 'repairDroid', text: 'Action: Spend 1 charge to repair 1 facedown damage card. Action: Repair 1 faceup Ship damage card.' }),
];

const damageDeck: DamageCardDef[] = [
  { id: 'panicked-pilot', name: 'Panicked Pilot', type: 'Pilot', count: 2, repairAction: false, text: 'Gain 2 stress tokens. Then repair this card.' },
  { id: 'blinded-pilot', name: 'Blinded Pilot', type: 'Pilot', count: 2, repairAction: true, text: 'While you attack, you can modify your dice only by spending force. Action: repair.' },
  { id: 'wounded-pilot', name: 'Wounded Pilot', type: 'Pilot', count: 2, repairAction: true, text: 'After you perform an action, roll 1 attack die; on a hit or crit gain 1 stress. Action: repair.' },
  { id: 'stunned-pilot', name: 'Stunned Pilot', type: 'Pilot', count: 2, repairAction: false, text: 'After you execute a maneuver, if you moved through or overlapped an obstacle, suffer 1 damage.' },
  { id: 'console-fire', name: 'Console Fire', type: 'Ship', count: 2, repairAction: true, text: 'Before you engage, roll 1 attack die; on a hit suffer 1 damage. Action: repair.' },
  { id: 'damaged-engine', name: 'Damaged Engine', type: 'Ship', count: 2, repairAction: false, text: 'Your turn maneuvers are one step more difficult.' },
  { id: 'weapons-failure', name: 'Weapons Failure', type: 'Ship', count: 2, repairAction: true, text: 'While you attack, roll 1 fewer attack die. Action: repair.' },
  { id: 'hull-breach', name: 'Hull Breach', type: 'Ship', count: 2, repairAction: true, text: 'Before you would suffer hit damage, suffer that much critical damage instead. Action: repair.' },
  { id: 'structural-damage', name: 'Structural Damage', type: 'Ship', count: 2, repairAction: false, text: 'While you defend, roll 1 fewer defense die.' },
  { id: 'damaged-sensors', name: 'Damaged Sensor Array', type: 'Ship', count: 2, repairAction: true, text: 'You cannot perform actions except focus and damage card actions. Action: repair.' },
  { id: 'loose-stabilizer', name: 'Loose Stabilizer', type: 'Ship', count: 2, repairAction: true, text: 'After you execute a non-straight maneuver, suffer 1 damage and repair this card. Action: repair.' },
  { id: 'power-regulator', name: 'Disabled Power Regulator', type: 'Ship', count: 2, repairAction: false, text: 'Before you engage, gain 1 ion token. After you execute an ion maneuver, repair this card.' },
  { id: 'fuel-leak', name: 'Fuel Leak', type: 'Ship', count: 4, repairAction: true, text: 'After you suffer critical damage, suffer 1 damage and repair this card. Action: repair.' },
  { id: 'direct-hit', name: 'Direct Hit!', type: 'Ship', count: 5, repairAction: false, text: 'Suffer 1 damage. Then repair this card.' },
];

const index = <T extends { id: string }>(xs: T[]): Record<string, T> => Object.fromEntries(xs.map(x => [x.id, x]));

export const CONTENT: Content = {
  factions: { coalition: { id: 'coalition', name: 'Free Coalition' }, dominion: { id: 'dominion', name: 'Iron Dominion' } },
  ships: index(ships), pilots: index(pilots), upgrades: index(upgrades), damageDeck,
};

export const PRESET_SQUADS = [
  { name: 'Crimson Flight', faction: 'coalition', ships: [
    { pilotId: 'lancer-prodigy-sl', upgrades: [] },
    { pilotId: 'lancer-deadeye', upgrades: ['predator', 'salvage-droid'] },
    { pilotId: 'bulwark-overseer', upgrades: ['ion-turret'] },
    { pilotId: 'bulwark-veteran', upgrades: ['ion-turret'] },
  ] },
  { name: 'Sable Wing', faction: 'dominion', ships: [
    { pilotId: 'stiletto-warlord-sl', upgrades: [] },
    { pilotId: 'dart-packleader', upgrades: ['crack-shot', 'predator'] },
    { pilotId: 'dart-brawler', upgrades: ['predator'] },
    { pilotId: 'dart-baron', upgrades: ['elusive'] },
    { pilotId: 'dart-ace', upgrades: [] },
    { pilotId: 'dart-ace', upgrades: [] },
  ] },
  { name: 'Lancer Patrol', faction: 'coalition', ships: [
    { pilotId: 'lancer-veteran', upgrades: ['predator'] },
    { pilotId: 'lancer-veteran', upgrades: ['predator'] },
    { pilotId: 'lancer-escort', upgrades: ['salvage-droid'] },
    { pilotId: 'lancer-escort', upgrades: ['salvage-droid'] },
  ] },
  { name: 'Dart Swarm', faction: 'dominion', ships: [
    { pilotId: 'dart-packleader', upgrades: ['elusive'] },
    { pilotId: 'dart-needle', upgrades: ['predator'] },
    { pilotId: 'dart-nightowl', upgrades: [] },
    { pilotId: 'dart-ace', upgrades: [] },
    { pilotId: 'dart-ace', upgrades: [] },
    { pilotId: 'dart-pilot', upgrades: [] },
    { pilotId: 'dart-cadet', upgrades: [] },
  ] },
  { name: 'Duel: Prodigy', faction: 'coalition', ships: [{ pilotId: 'lancer-prodigy-sl', upgrades: [] }, { pilotId: 'lancer-escort', upgrades: [] }] },
  { name: 'Duel: Warlord', faction: 'dominion', ships: [{ pilotId: 'stiletto-warlord-sl', upgrades: [] }, { pilotId: 'dart-ace', upgrades: [] }, { pilotId: 'dart-cadet', upgrades: [] }] },
];
