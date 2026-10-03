// Все размеры в метрах, время в секундах, скорости в м/с.

export const MODEL_SCALE = 0.16; // bottle.glb имеет высоту 2.0 → 0.32 м
export const BOTTLE_HEIGHT = 2.0 * MODEL_SCALE;

export const GRAVITY = 9.81;
export const PHYS_DT = 1 / 120;
export const MAX_SUBSTEPS = 8;

export const CAMERA = {
  y: 1.6,
  lookY: 1.32,
  lookYPortrait: 0.55, // в портрете смотрим ниже — меньше потолка, больше пола под полётом
  lookZ: -8,
  baseVFov: 50,
  minHFovLandscape: 62,
  minHFovPortrait: 54,
  maxVFov: 92,
};

export const TRAY = {
  slotsLandscape: 5,
  slotsPortrait: 4,
  minSpacing: 0.19,
  maxSpacing: 0.25,
  bottleScreenFraction: 0.205, // максимальная доля высоты экрана под бутылку
  shelfNdcY: -0.72, // где на экране стоит дно бутылок
  depth: 0.3, // глубина полки
  shelfThickness: 0.022,
  railHeight: 0.045,
  releaseAboveBottle: 0.1, // линия автоброска над верхушками бутылок
  arriveSpeed: 1.25,
  spawnStagger: 0.22,
};

export const BOTTLE = {
  mass: 0.55,
  comY: 0.105,
  friction: 0.38,
  restitution: 0.12,
  shelfFriction: 0.8,
  // возврат на место
  homeGain: 5.0, // 1/с: желаемая скорость = gain * ошибка
  homeMaxSpeed: 0.55,
  homeImpulseGain: 0.35,
  homeMaxForce: 7.0,
  uprightK: 0.4, // Н·м/рад
  uprightD: 0.06,
  uprightMax: 1.25,
  yawK: 0.05,
  yawD: 0.012,
};

export const HOLD = {
  follow: 38, // 1/с: скорость догоняния пальца
  maxSpeed: 14,
  lift: 0.03,
  leanPerSpeed: 0.075,
  leanMax: 0.32,
  pushLean: 0.2,
};

export const THROW = {
  minUp: 1.05, // экранных высот/с вверх для броска при отпускании
  autoUp: 1.7, // ...и для автоматического отпускания за линией
  maxSideRatio: 1.35, // |vx| / vy
  minRise: 0.03, // доля экрана, на которую палец поднялся за последние 120 мс
  speedMin: 3.0,
  speedMax: 12.5,
  gestureMin: 1.0,
  gestureMax: 6.5,
  elevationDeg: 41,
  yawMaxDeg: 38,
  spinBase: 4.0,
  spinPerPower: 7.0,
  assistSpeed: 0.11, // доля скорости, которую может подправить автоприцел
  assistYawDeg: 5.5,
  assistBlend: 0.6,
};

export const BREAK = {
  bottleBottle: 1.9,
  bottleTarget: 2.4,
  bottleStatic: 4.2,
  heldStatic: 99, // удерживаемая бутылка о статику не бьётся (кинематика)
};

export const TARGET = {
  mass: 3.6,
  linearDamping: 0.06,
  angularDamping: 0.4,
  thickness: 0.06,
};

export const SHARDS = {
  maxSets: 4,
  lifeMin: 2.6,
  lifeMax: 4.0,
  fade: 0.45,
  burst: 0.2,
  burstMax: 3.2,
};

export const LIQUID_COLORS = [
  { name: 'апельсин', color: 0xf08a24, surface: 0xffc072 },
  { name: 'вишня', color: 0xb02a3c, surface: 0xe2677a },
  { name: 'лайм', color: 0x86b83a, surface: 0xc9e88a },
  { name: 'черника', color: 0x4a4fa8, surface: 0x8d92e0 },
  { name: 'мята', color: 0x2fa58f, surface: 0x86dcc8 },
  { name: 'мёд', color: 0xd9a52c, surface: 0xf6d77a },
  { name: 'гранат', color: 0x8e2a5a, surface: 0xd06b9a },
];

// Группы столкновений Rapier: старшие 16 бит — членство, младшие — фильтр.
export const G = {
  STATIC: 1 << 0,
  TRAY: 1 << 1,
  HELD: 1 << 2,
  THROWN: 1 << 3,
  TARGET: 1 << 4,
  SHARD: 1 << 5,
  DEBRIS_STATIC: 1 << 6, // статика, с которой сталкиваются только осколки (полка)
};

export function groups(member, filter) {
  return ((member & 0xffff) << 16) | (filter & 0xffff);
}

export const GROUPS = {
  static: groups(G.STATIC, G.TRAY | G.THROWN | G.TARGET | G.SHARD),
  shelf: groups(G.STATIC | G.DEBRIS_STATIC, G.TRAY | G.THROWN | G.SHARD),
  tray: groups(G.TRAY, G.STATIC | G.TRAY | G.HELD | G.THROWN),
  held: groups(G.HELD, G.TRAY | G.THROWN),
  thrown: groups(G.THROWN, G.STATIC | G.TRAY | G.HELD | G.THROWN | G.TARGET),
  target: groups(G.TARGET, G.THROWN | G.SHARD),
  shard: groups(G.SHARD, G.STATIC | G.TARGET),
  anchor: groups(0, 0),
};
