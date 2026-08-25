// ─── Tipos del Flow Editor ─────────────────────────────────────
export type NodeType = 'connection' | 'historian' | 'start' | 'stop';

export interface FlowNodePosition {
  x: number;
  y: number;
}

export interface FlowNodeData {
  id: string;
  type: NodeType;
  label: string;
  position: FlowNodePosition;
  config: Record<string, any>;
  status: 'idle' | 'saving' | 'ok' | 'error';
  statusMsg?: string;
}

export interface FlowConnection {
  id: string;
  from: string;       // nodeId
  fromPort: 'output';
  to: string;         // nodeId
  toPort: 'input';
}

// ─── Catálogo de nodos ─────────────────────────────────────────
export interface NodeCatalogEntry {
  type: NodeType;
  label: string;
  category: 'bd' | 'historian';
  icon: string;        // lucide icon name
  color: string;       // tailwind border/accent
  defaultConfig: Record<string, any>;
}

export const NODE_CATALOG: NodeCatalogEntry[] = [
  {
    type: 'connection',
    label: 'Conexión BD',
    category: 'bd',
    icon: 'Database',
    color: 'siemens',
    defaultConfig: {
      db_id: '',
      motor: 'mysql',
      nombre: '',
      host: 'localhost',
      puerto: 3306,
      base_datos: '',
      usuario: '',
      password: '',
      opciones: {},
      autoconectar: true,
    },
  },
  {
    type: 'historian',
    label: 'Historian',
    category: 'historian',
    icon: 'Activity',
    color: 'amber',
    defaultConfig: {
      grupo_id: '',
      db_id: '',
      // 'todos' -> se manda `tags: []`, que para el backend significa TODOS los
      // tags de todos los PLCs. 'seleccion' -> se manda la lista de `tags`.
      // Solo vive en el frontend: NO viaja en el POST.
      modo_tags: 'todos',
      tags: [],
      tabla: 'historico_tags',
      nombre: '',
      activo: true,
      banda_muerta: 0,
      intervalo_min_ms: 0,
    },
  },
  {
    type: 'start',
    label: 'Start',
    category: 'historian',
    icon: 'Play',
    color: 'green',
    defaultConfig: {
      grupo_id: '',
    },
  },
  {
    type: 'stop',
    label: 'Stop',
    category: 'historian',
    icon: 'Square',
    color: 'red',
    defaultConfig: {
      grupo_id: '',
    },
  },
];

/** Color del catálogo -> clase de fondo, para los puntitos del menú. */
export const COLOR_DOT: Record<string, string> = {
  siemens: 'bg-siemens',
  amber: 'bg-amber-500',
  green: 'bg-green-500',
  red: 'bg-red-500',
};

// Motor-specific port defaults
export const MOTOR_PORTS: Record<string, number> = {
  mysql: 3306,
  postgresql: 5432,
  mssql: 1433,
  sqlite: 0,
};
