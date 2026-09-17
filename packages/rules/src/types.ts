import type { ArcName, Bearing, Pose, Poly, ShipSize } from './geometry';

export type PlayerId = 0 | 1;
export type ActionType = 'focus' | 'evade' | 'lock' | 'barrelRoll' | 'boost' | 'calculate' | 'reload' | 'rotate' | 'card';
export type ActionDifficulty = 'W' | 'R';
export type AttackFace = 'blank' | 'focus' | 'hit' | 'crit';
export type DefenseFace = 'blank' | 'focus' | 'evade';
export type Face = AttackFace | DefenseFace;
export type TokenName = 'focus' | 'evade' | 'calculate' | 'stress' | 'strain' | 'ion' | 'disarm';
export type Phase = 'setup' | 'planning' | 'system' | 'activation' | 'engagement' | 'end' | 'over';
export type TurretFacing = 'front' | 'left' | 'right' | 'rear';

// ---------- content ----------

export interface ActionDef { type: ActionType; difficulty: ActionDifficulty; linked?: { type: ActionType; difficulty: ActionDifficulty } }

export interface ShipDef {
  id: string; name: string; faction: string; size: ShipSize;
  dial: string[]; attack: number; agility: number; hull: number; shields: number;
  actions: ActionDef[];
  shipAbility?: { id: string; name: string; text: string };
  /** key for the renderer's built-in placeholder mesh */
  mesh: string;
}

export interface ChargeDef { value: number; recovers: number }

export interface PilotDef {
  id: string; shipId: string; name: string; caption?: string;
  initiative: number; limited: number; cost: number; loadout: number;
  slots: string[];
  force?: ChargeDef; charges?: ChargeDef;
  ability?: string; text?: string;
  standardLoadout?: string[];
}

export interface WeaponDef { arc: 'front' | 'turret'; value: number; minRange: number; maxRange: number; ordnance: boolean; requires?: 'lock' | 'focus'; ion?: boolean; chargeCost?: number }

export interface UpgradeDef {
  id: string; name: string; slot: string; cost: number; limited: number;
  charges?: ChargeDef;
  attack?: WeaponDef;
  addActions?: ActionDef[];
  stat?: { hull?: number; shields?: number };
  ability?: string; text: string;
  restrictions?: { sizes?: ShipSize[]; needsForce?: boolean; standardLoadoutOnly?: boolean };
}

export interface DamageCardDef { id: string; name: string; type: 'Ship' | 'Pilot'; count: number; text: string; repairAction: boolean }

export interface Content {
  factions: Record<string, { id: string; name: string }>;
  ships: Record<string, ShipDef>;
  pilots: Record<string, PilotDef>;
  upgrades: Record<string, UpgradeDef>;
  damageDeck: DamageCardDef[];
}

export interface SquadShip { pilotId: string; upgrades: string[] }
export interface Squad { name: string; faction: string; ships: SquadShip[] }

// ---------- state ----------

export interface DamageCard { cardId: string; faceup: boolean }
export interface UpgradeState { id: string; charges: number }

export interface ShipState {
  id: string; owner: PlayerId; pilotId: string; shipId: string; label: string;
  cost: number; initiative: number;
  pose: Pose; placed: boolean;
  hull: number; shieldsMax: number; shields: number;
  damage: DamageCard[];
  upgrades: UpgradeState[];
  charges: number; force: number; forceMax: number;
  tokens: Record<TokenName, number>;
  lock: string | null;
  turret: TurretFacing | null;
  /** index into ShipDef.dial; -1 = none; -2 = set but hidden (redacted views only) */
  dial: number;
  dialRevealed: boolean;
  actionsThisRound: ActionType[];
  activated: boolean; engaged: boolean;
  destroyed: boolean; removed: boolean; fled: boolean;
  wasIonizedAtReveal?: boolean;
}

export type ObstacleKind = 'asteroid' | 'debris' | 'gas';
export interface Obstacle { id: string; kind: ObstacleKind; poly: Poly; seed: number }

export interface Option {
  id: string; label: string;
  action?: ActionType; red?: boolean;
  pose?: Pose; targetId?: string; shipId?: string;
  weapon?: string; arc?: ArcName; range?: number; obstructed?: boolean; dice?: number;
  facing?: TurretFacing; upgradeIdx?: number; cardIdx?: number;
  /** when set, the command must carry `dice` indices (0..max selections) */
  pickDice?: { max: number };
  detail?: string;
}

export type Decision =
  | { type: 'placeShip'; player: PlayerId; shipId: string }
  | { type: 'planning'; players: PlayerId[] }
  | { type: 'choice'; player: PlayerId; kind: ChoiceKind; shipId?: string; prompt: string; options: Option[] };

export type ChoiceKind = 'activateShip' | 'tallon' | 'action' | 'engageShip' | 'attack' | 'modifyAttack' | 'modifyDefense' | 'ability' | 'chooseShip';

export type Command =
  | { type: 'placeShip'; player: PlayerId; shipId: string; pose: Pose }
  | { type: 'setDials'; player: PlayerId; dials: Record<string, number> }
  | { type: 'choose'; player: PlayerId; option: number; dice?: number[] };

export interface AttackState {
  attacker: string; defender: string; weapon: string; arc: ArcName;
  range: number; obstructed: boolean;
  attackDice: AttackFace[]; defenseDice: DefenseFace[];
  attackRerolled: boolean[]; defenseRerolled: boolean[];
  used: string[];
  bullseye: boolean;
  noLockSpend?: boolean;
}

export interface Frame { type: string; step: number; [k: string]: any }

export interface PlayerState { name: string; squadName: string; faction: string; squadPoints: number; score: number }

export interface GameState {
  version: 1;
  rng: number;
  round: number; phase: Phase; firstPlayer: PlayerId;
  players: [PlayerState, PlayerState];
  ships: Record<string, ShipState>;
  shipOrder: string[];
  obstacles: Obstacle[];
  deck: string[]; discard: string[];
  stack: Frame[];
  pending: Decision | null;
  attack: AttackState | null;
  winner: PlayerId | 'draw' | null;
  options: GameOptions;
}

export interface GameOptions { maxRounds: number; targetScore: number; obstacleCount: number }

export type GameEvent =
  | { t: 'round'; round: number; firstPlayer: PlayerId }
  | { t: 'phase'; phase: Phase }
  | { t: 'placed'; shipId: string; pose: Pose }
  | { t: 'dialsSet'; player: PlayerId }
  | { t: 'reveal'; shipId: string; code: string }
  | { t: 'move'; shipId: string; kind: 'maneuver' | 'ion' | 'barrelRoll' | 'boost'; from: Pose; to: Pose; speed: number; bearing: Bearing; travelled: number; full: boolean; difficulty: 'B' | 'W' | 'R' }
  | { t: 'bump'; shipId: string; otherId: string }
  | { t: 'obstacle'; shipId: string; obstacleId: string; kind: ObstacleKind }
  | { t: 'token'; shipId: string; token: TokenName | 'charge' | 'force' | 'shield'; delta: number; upgradeIdx?: number }
  | { t: 'lock'; shipId: string; targetId: string | null }
  | { t: 'action'; shipId: string; action: ActionType; label: string; red: boolean }
  | { t: 'turret'; shipId: string; facing: TurretFacing }
  | { t: 'ability'; shipId: string; name: string }
  | { t: 'attack'; attacker: string; defender: string; weapon: string; weaponName: string; range: number; obstructed: boolean }
  | { t: 'dice'; pool: 'attack' | 'defense'; shipId: string; dice: Face[]; cause: string }
  | { t: 'attackResult'; attacker: string; defender: string; hit: boolean; hits: number; crits: number }
  | { t: 'damage'; shipId: string; shields: number; facedown: number; faceup: string[] }
  | { t: 'crit'; shipId: string; cardId: string; name: string }
  | { t: 'repair'; shipId: string; cardId: string }
  | { t: 'destroyed'; shipId: string }
  | { t: 'removed'; shipId: string; reason: 'destroyed' | 'fled' }
  | { t: 'score'; scores: [number, number] }
  | { t: 'roll'; shipId: string; die: AttackFace; cause: string }
  | { t: 'gameOver'; winner: PlayerId | 'draw' }
  | { t: 'log'; text: string };
