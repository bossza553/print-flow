// Workflow definition: the order a book travels through the factory.
// 1. admin picks books (basket -> submit)  => job enters stage "cut"
// 2. cut      ตัดกระดาษ
// 3. print    พิมพ์  (machines: 2สี, 4สี, 6สี, 8สี-1, 8สี-2)
// 4. fold     เครื่องพับ
// 5. bind     เก็บ-ไส-ตัด
// 6. wrap     ห่อ แล้วส่งเข้าคลัง
// 7. done     อยู่ในคลัง

export const STAGES = [
  { key: 'cut',   name: 'ตัดกระดาษ',     role: 'cutter'  },
  { key: 'print', name: 'พิมพ์',          role: 'printer' },
  { key: 'fold',  name: 'พับ',            role: 'folder'  },
  { key: 'bind',  name: 'เก็บ-ไส-ตัด',    role: 'binder'  },
  { key: 'wrap',  name: 'ห่อ / ส่งคลัง',  role: 'wrapper' },
  { key: 'done',  name: 'เข้าคลังแล้ว',   role: null      },
];

export const ROLES = {
  admin:   'ผู้ดูแลระบบ',
  cutter:  'ช่างตัดกระดาษ',
  printer: 'ช่างพิมพ์',
  folder:  'ช่างพับ',
  binder:  'เก็บ-ไส-ตัด',
  wrapper: 'ห่อ / ส่งคลัง',
};

export const COLORS = ['2สี', '4สี', '6สี', '8สี'];

export const MACHINES = [
  { key: '2สี',   color: '2สี' },
  { key: '4สี',   color: '4สี' },
  { key: '6สี',   color: '6สี' },
  { key: '8สี-1', color: '8สี' },
  { key: '8สี-2', color: '8สี' },
];

export function stageByKey(key) {
  return STAGES.find(s => s.key === key);
}

export function nextStage(key) {
  const i = STAGES.findIndex(s => s.key === key);
  if (i < 0 || i >= STAGES.length - 1) return null;
  return STAGES[i + 1];
}

export function machineColor(machineKey) {
  return MACHINES.find(m => m.key === machineKey)?.color || null;
}

/** Can this user act on a job that is currently in `stage`? */
export function canWork(user, job) {
  if (!user || !job) return false;
  if (user.role === 'admin') return true;
  const stage = stageByKey(job.stage);
  if (!stage || stage.role !== user.role) return false;
  if (user.role === 'printer') {
    return machineColor(user.machine) === job.color;
  }
  return true;
}
