import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import {
  ArrowLeftIcon,
  SaveIcon,
  CheckCircle2Icon,
  DatabaseIcon,
  SlidersHorizontalIcon,
  CpuIcon,
  WifiOffIcon,
  PlusIcon,
  Trash2Icon,
  XIcon,
  SearchIcon,
  AlertCircleIcon,
  FileCodeIcon,
  InfoIcon,
  TagIcon,
  ActivityIcon,
  Link2Icon,
  RefreshCwIcon,
  MonitorIcon,
  PencilIcon,
  UploadIcon,
  AlertTriangleIcon,
  type LucideIcon,
} from 'lucide-react';
import { useAppStore } from '../context/AppStore';
import { UPDATE_RATE_OPTIONS, DataType, PlcVendor, VENDOR_LABEL } from '../models/plc';
import { formatValue, formatValueFull } from '../utils/format';
import { fetchRexrothPrograms } from '../services/rexrothApi';
import { PanelBasesDatos } from '../components/bd/PanelBasesDatos';
import { PanelCarpetaDatos } from '../components/sistema/PanelCarpetaDatos';
import { PanelEscritura, type EstadoEscritura } from '../components/escritura/PanelEscritura';
import { listarPermitidos } from '../services/escrituraApi';

// =========================================================================
// LA VISTA DE CONFIGURACIÓN, EN TRES SECCIONES
//
// Antes era una sola página con cinco bloques apilados: PLCs, variables,
// bases de datos, ajustes y carpeta de datos. Todo a la vez, todo del mismo
// peso visual, y con la lista de variables —la única que crece sin límite—
// empujando el resto fuera de la pantalla.
//
// Ahora hay un panel lateral con TRES destinos, y cada uno responde a una
// pregunta distinta:
//
//   Controladores    ¿qué PLCs hay y qué variables quiero de cada uno?
//   Bases de datos   ¿dónde se guarda y qué conexiones responden?
//   Sistema          ¿cómo se comporta esta vista y dónde viven mis datos?
//
// Dentro de Controladores el patrón es maestro-detalle en tres columnas
// —lista de PLCs, variables del elegido, ficha del enlace— porque la
// pregunta real nunca fue "enséñame todos los tags de todos los PLCs a la
// vez", sino "de ESTE controlador, ¿cuáles quiero?".
//
// Lo que NO cambió: ni un `fetch`, ni un handler, ni el modal de alta. Esto
// reorganiza la superficie, no el motor.
// =========================================================================

// «escritura» es la lista blanca: qué tags del PLC puede tocar el HMI. Va
// junto a «controladores» y no en «sistema» porque es una decisión SOBRE el
// PLC, no un ajuste de esta vista.
type Seccion = 'controladores' | 'bd' | 'sistema' | 'escritura';

/**
 * Color del tipo de dato.
 *
 * Cada tipo lleva su par claro/oscuro y un anillo que le da borde: con solo
 * las variantes claras, en modo oscuro salían pastillas pastel flotando.
 */
const typeColor: Record<DataType, string> = {
  bool:
    'bg-violet-100 text-violet-700 ring-violet-200 ' +
    'dark:bg-violet-500/15 dark:text-violet-300 dark:ring-violet-500/25',
  int:
    'bg-blue-100 text-blue-700 ring-blue-200 ' +
    'dark:bg-blue-500/15 dark:text-blue-300 dark:ring-blue-500/25',
  double:
    'bg-teal-100 text-teal-700 ring-teal-200 ' +
    'dark:bg-teal-500/15 dark:text-teal-300 dark:ring-teal-500/25',
  string:
    'bg-amber-100 text-amber-700 ring-amber-200 ' +
    'dark:bg-amber-500/15 dark:text-amber-300 dark:ring-amber-500/25',
};

interface PlcInfo {
  plc: string;          // backend devuelve "plc", no "plc_id"
  nombre: string;
  vendor: string;
  endpoint: string;
  conectado: boolean;
  estado_conexion: string;
  num_tags: number;
  modo_lectura: string;
  /** Modelo de la CPU si el driver lo leyó ("CPU 1214C DC/DC/Rly"). */
  modelo?: string;
  /** Por qué está desconectado, si lo está. */
  ultimo_error?: string;
  sampling_interval_ms: number;
  publishing_interval_ms: number;
}

/**
 * IP legible a partir del endpoint, sea cual sea el esquema:
 *   opc.tcp://192.168.0.1:4840   (Siemens, Rexroth por OPC UA)
 *   https://192.168.0.1:443      (Rexroth por Data Layer)
 *   enip://192.168.0.1:44818/0   (Allen-Bradley; /0 es el slot)
 */
const ipDe = (endpoint: string) =>
  (endpoint || '').replace(/^[a-z.+-]+:\/\//i, '').replace(/[:/].*$/, '');

const marcaDe = (vendor: string) =>
  VENDOR_LABEL[vendor] ?? VENDOR_LABEL.siemens;

// =========================================================================
// Piezas del sistema visual
// =========================================================================

/** Superficie base. Todas las tarjetas de la vista salen de aquí. */
function Tarjeta({
  children,
  className = '',
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`overflow-hidden rounded-xl border border-slate-200 bg-white shadow-card dark:border-navy-slate dark:bg-navy-soft ${className}`}
    >
      {children}
    </div>
  );
}

/** Encabezado de sección: icono, título, descripción y acciones. */
function CabeceraSeccion({
  icon,
  titulo,
  descripcion,
  acciones,
}: {
  icon: React.ReactNode;
  titulo: string;
  descripcion: string;
  acciones?: React.ReactNode;
}) {
  return (
    <div className="mb-5 flex flex-wrap items-start justify-between gap-x-4 gap-y-3">
      <div className="flex min-w-0 items-start gap-3">
        <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-siemens-50 text-siemens dark:bg-siemens/15">
          {icon}
        </span>
        <div className="min-w-0">
          <h2 className="text-lg font-bold leading-tight text-navy dark:text-slate-100">
            {titulo}
          </h2>
          <p className="mt-0.5 text-[12.5px] leading-relaxed text-slate-400">
            {descripcion}
          </p>
        </div>
      </div>
      {acciones && <div className="flex shrink-0 items-center gap-2">{acciones}</div>}
    </div>
  );
}

/** Punto + texto de estado. El mismo par en PLCs y en bases de datos. */
function ChipEstado({ ok, si, no }: { ok: boolean; si: string; no: string }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-semibold ring-1 ${
        ok
          ? 'bg-state-ok/10 text-state-ok ring-state-ok/25'
          : 'bg-state-error/10 text-state-error ring-state-error/25'
      }`}
    >
      <span
        aria-hidden="true"
        className={`h-1.5 w-1.5 rounded-full ${ok ? 'bg-state-ok' : 'bg-state-error'}`}
      />
      {ok ? si : no}
    </span>
  );
}

/**
 * Indicador de la barra superior.
 *
 * Los tres dicen lo mismo de un vistazo: cuántos de cuántos. Un número solo
 * ("6 variables") no informa; "3/5 bases" sí, porque lleva dentro el total.
 */
function ChipDato({
  icon,
  valor,
  etiqueta,
  alerta,
}: {
  icon: React.ReactNode;
  valor: string;
  etiqueta: string;
  alerta?: boolean;
}) {
  return (
    <span
      className={`inline-flex items-center gap-2 whitespace-nowrap rounded-lg px-2.5 py-1.5 text-xs ring-1 ${
        alerta
          ? 'bg-state-error/10 text-state-error ring-state-error/25'
          : 'bg-siemens/10 text-siemens-700 ring-siemens/20 dark:text-siemens-200'
      }`}
    >
      {icon}
      <b className="font-bold tabular-nums">{valor}</b>
      <span className="opacity-70">{etiqueta}</span>
    </span>
  );
}

/** Celda de cabecera de tabla. */
function Th({
  children,
  className = '',
}: {
  children?: React.ReactNode;
  className?: string;
}) {
  return (
    <th
      scope="col"
      className={`whitespace-nowrap border-b border-slate-200 bg-slate-50 px-4 py-2.5 text-left text-[10px] font-bold uppercase tracking-wider text-slate-400 dark:border-navy-slate dark:bg-navy ${className}`}
    >
      {children}
    </th>
  );
}

/** Entrada del panel lateral. */
function ItemNav({
  activo,
  onClick,
  icon: Icono,
  label,
  badge,
  alerta,
}: {
  activo: boolean;
  onClick: () => void;
  icon: LucideIcon;
  label: string;
  badge?: string;
  alerta?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={activo ? 'page' : undefined}
      className={`flex w-full items-center gap-2.5 rounded-lg px-3 py-2.5 text-left text-[13px] font-semibold outline-none transition focus-visible:ring-2 focus-visible:ring-siemens/40 ${
        activo
          ? 'bg-siemens/10 text-siemens ring-1 ring-siemens/25 dark:text-siemens-200'
          : 'text-slate-500 hover:bg-slate-100 hover:text-navy dark:text-slate-400 dark:hover:bg-navy-slate/40 dark:hover:text-slate-100'
      }`}
    >
      <Icono className="h-4 w-4 shrink-0" />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {badge && (
        <span
          className={`shrink-0 whitespace-nowrap text-[11px] tabular-nums ${
            alerta ? 'font-bold text-state-error' : 'font-medium text-slate-400'
          }`}
        >
          {alerta && <span aria-hidden="true">● </span>}
          {badge}
        </span>
      )}
    </button>
  );
}

/**
 * Tarjeta de un controlador en la lista de la izquierda.
 *
 * Es un BOTÓN entero, no una fila con un enlace dentro: el gesto natural es
 * "pulsar el PLC para ver lo suyo", y reducir eso a un área de clic pequeña
 * solo produce clics que no hacen nada.
 */
function TarjetaPlc({
  plc,
  activo,
  enUso,
  onClick,
  t,
}: {
  plc: PlcInfo;
  activo: boolean;
  enUso: number;
  onClick: () => void;
  t: (k: string) => string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={activo}
      className={`w-full rounded-xl border p-3 text-left outline-none transition focus-visible:ring-2 focus-visible:ring-siemens/40 ${
        activo
          ? 'border-siemens/40 bg-siemens/5 ring-1 ring-siemens/20 dark:bg-siemens/10'
          : 'border-slate-200 bg-white hover:border-slate-300 hover:bg-slate-50 dark:border-navy-slate dark:bg-navy-soft dark:hover:bg-navy/60'
      }`}
    >
      <div className="flex items-start gap-2.5">
        <span
          className={`mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg ${
            activo
              ? 'bg-siemens/15 text-siemens'
              : 'bg-slate-100 text-slate-400 dark:bg-navy dark:text-slate-500'
          }`}
        >
          <CpuIcon className="h-4 w-4" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-[13px] font-bold text-navy dark:text-slate-100">
            {plc.plc}
          </p>
          <p className="truncate font-mono text-[11px] text-slate-400">
            {ipDe(plc.endpoint)}
          </p>
        </div>
        <ChipEstado
          ok={plc.conectado}
          si={t('config.plcOnline')}
          no={t('config.plcOffline')}
        />
      </div>

      <div className="mt-2.5 flex items-center gap-3 border-t border-slate-100 pt-2 text-[11px] text-slate-400 dark:border-navy-slate/60">
        <span className="inline-flex items-center gap-1">
          <TagIcon className="h-3 w-3" />
          <b className="tabular-nums text-slate-500 dark:text-slate-300">
            {plc.num_tags}
          </b>{' '}
          tags
        </span>
        {enUso > 0 && (
          <span className="text-siemens">
            <b className="tabular-nums">{enUso}</b> en uso
          </span>
        )}
        <span className="ml-auto truncate font-mono">{plc.modo_lectura}</span>
      </div>
    </button>
  );
}

/** Fila de la ficha del enlace: etiqueta a la izquierda, dato a la derecha. */
function FilaDato({
  etiqueta,
  children,
}: {
  etiqueta: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-slate-100 px-4 py-2.5 last:border-0 dark:border-navy-slate/60">
      <span className="shrink-0 text-[12px] text-slate-400">{etiqueta}</span>
      <span className="min-w-0 truncate text-right text-[12.5px] font-medium text-navy dark:text-slate-100">
        {children}
      </span>
    </div>
  );
}

/**
 * Fila de ajuste: nombre y explicación a la izquierda, control a la derecha.
 *
 * `SelectField` pone la etiqueta ENCIMA del control, que en una columna
 * estrecha va bien pero aquí desperdicia el ancho y deja la explicación sin
 * sitio. Esta variante es solo maquetación: el `<select>` es el mismo control
 * nativo de siempre.
 */
function FilaAjuste<T extends string | number>({
  titulo,
  descripcion,
  value,
  options,
  onChange,
}: {
  titulo: string;
  descripcion: string;
  value: T;
  options: { label: string; value: T }[];
  onChange: (v: T) => void;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2 border-b border-slate-100 px-4 py-3.5 last:border-0 dark:border-navy-slate/60">
      <div className="min-w-0 flex-1">
        <p className="text-[13.5px] font-semibold text-navy dark:text-slate-100">
          {titulo}
        </p>
        <p className="mt-0.5 text-[11.5px] leading-relaxed text-slate-400">
          {descripcion}
        </p>
      </div>
      <select
        value={String(value)}
        onChange={(e) => {
          const m = options.find((o) => String(o.value) === e.target.value);
          if (m) onChange(m.value);
        }}
        className="w-full min-w-[180px] shrink-0 rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-navy outline-none transition focus:border-siemens focus:ring-2 focus:ring-siemens/20 dark:border-navy-slate dark:bg-navy dark:text-slate-100 sm:w-auto"
      >
        {options.map((o) => (
          <option key={String(o.value)} value={String(o.value)}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  );
}

// =========================================================================
// Página
// =========================================================================
export function Configuracion() {
  const navigate = useNavigate();
  const {
    variables,
    toggleVariable,
    config,
    setUpdateRate,
    setTheme,
    setLanguage,
    saveConfig,
    t,
  } = useAppStore();

  const [saved, setSaved] = useState(false);

  // ── Estado de INTERFAZ ───────────────────────────────────────────────
  // Qué sección se está viendo, qué controlador está elegido y qué se
  // escribió en el buscador. Nada de esto sale al backend ni cambia lo
  // que se guarda: es dónde está mirando el usuario, no qué hay.
  // De dónde se llega. El Diseñador manda aquí con `?seccion=escritura&tag=…`
  // cuando alguien pulsa «Habilitar este tag» sobre un tag que no lo está: se
  // abre la sección correcta con el buscador ya puesto, en vez de soltar a la
  // persona en la primera pantalla a que lo encuentre otra vez.
  //
  // Se lee UNA vez, al montar: si se siguiera mirando, cambiar de sección a
  // mano te devolvería a «escritura» en el siguiente render, y la URL manda
  // sobre lo que estás pulsando — que es exactamente al revés de lo que hace
  // falta.
  const [params] = useSearchParams();
  const [seccionInicial] = useState<Seccion>(() =>
  params.get('seccion') === 'escritura' ? 'escritura' : 'controladores'
  );
  const [tagBuscado] = useState(() => params.get('tag') ?? '');

  const [seccion, setSeccion] = useState<Seccion>(seccionInicial);
  const [plcSel, setPlcSel] = useState<string>('');
  const [buscaVar, setBuscaVar] = useState('');
  const [bdCuenta, setBdCuenta] = useState({ total: 0, conectadas: 0 });

  // Cuántos tags hay habilitados para escritura, para la insignia del menú.
  //
  // Se pide al entrar y NO al abrir la sección: una lista blanca vacía es
  // justo lo que hay que ver desde fuera —significa que ningún widget puede
  // escribir— y esperar a que alguien entre para contarlo lo esconde. Es una
  // sola petición y el panel la devuelve actualizada cuando cambia algo.
  const [escrituraCuenta, setEscrituraCuenta] = useState<EstadoEscritura>({
    habilitados: 0,
    candidatos: 0
  });

  useEffect(() => {
    let vivo = true;
    listarPermitidos().
    then((l) => {
      if (vivo) setEscrituraCuenta((p) => ({ ...p, habilitados: l.length }));
    }).
    catch(() => {
      // Sin permiso (403) o sin backend: la insignia se queda en 0 y la
      // sección ya explica lo que pasa al abrirla.
    });
    return () => {
      vivo = false;
    };
  }, []);
  const selectedCount = variables.filter((v) => v.selected).length;

  // ---------- PLCs desde GET /health ----------
  const [plcs, setPlcs] = useState<PlcInfo[]>([]);

  const refreshPlcs = useCallback(async () => {
    try {
      const res = await fetch('/health');
      if (!res.ok) return;
      const data = await res.json();
      if (Array.isArray(data.plcs)) setPlcs(data.plcs);
    } catch {
      /* backend no disponible */
    }
  }, []);

  useEffect(() => {
    refreshPlcs();
    // El sondeo cada 5 s es la red de seguridad. Lo normal es que el estado
    // cambie por el WebSocket: al conectar o perder un PLC el backend manda
    // `status`, y al alta/baja un `snapshot` o `plc_removed`. Con eso se
    // refresca en el acto, y «0/1 PLC en línea» pasa a «1/1» cuando pasa,
    // no hasta 5 s después. También al recuperar el propio socket
    // (`hmi:conexion`), que es cuando lo que se ve puede estar más viejo.
    const id = setInterval(refreshPlcs, 5000);
    const porWs = (ev: Event) => {
      const t = (ev as CustomEvent).detail?.type;
      if (t === 'status' || t === 'snapshot' || t === 'plc_removed') {
        void refreshPlcs();
      }
    };
    const porConexion = (ev: Event) => {
      if ((ev as CustomEvent).detail?.vivo) void refreshPlcs();
    };
    window.addEventListener('hmi:ws', porWs);
    window.addEventListener('hmi:conexion', porConexion);
    return () => {
      clearInterval(id);
      window.removeEventListener('hmi:ws', porWs);
      window.removeEventListener('hmi:conexion', porConexion);
    };
  }, [refreshPlcs]);

  // ---------- Modal "Agregar PLC" ----------
  const [showModal, setShowModal] = useState(false);
  const [vendor, setVendor] = useState<PlcVendor>('siemens');
  const [newIp, setNewIp] = useState('');
  const [newUser, setNewUser] = useState('');
  const [newPass, setNewPass] = useState('');
  const [app, setApp] = useState('');        // autodetectada por el backend
  const [programs, setPrograms] = useState<string[]>([]);
  const [program, setProgram] = useState('');
  const [searching, setSearching] = useState(false);
  const [adding, setAdding] = useState(false);
  const [modalError, setModalError] = useState('');
  const [modalHint, setModalHint] = useState('');
  // Allen-Bradley: slot del procesador. EtherNet/IP no tiene credenciales.
  const [slot, setSlot] = useState('0');
  // Siemens: por dónde hablar con la CPU. Un S7-1200 sin OPC UA (FW < 4.4
  // o servidor sin activar) solo se puede leer por S7comm, y ahí los tags
  // no se descubren: se escriben a mano con su DB y su offset.
  const [s7Transporte, setS7Transporte] = useState<'opcua' | 's7comm'>('opcua');
  const [s7Rack, setS7Rack] = useState('0');
  const [s7Slot, setS7Slot] = useState('1');
  const [s7Tags, setS7Tags] = useState('');
  // Importación desde las fuentes de TIA (`Generate source from blocks`):
  // la app calcula los offsets; el usuario solo marca qué variables quiere.
  const [s7Bloques, setS7Bloques] = useState<BloqueTia[]>([]);
  const [s7Importando, setS7Importando] = useState(false);
  const [s7Manual, setS7Manual] = useState(false);
  const [s7Arrastrando, setS7Arrastrando] = useState(false);
  const [s7Pegado, setS7Pegado] = useState('');
  const s7FicherosRef = React.useRef<HTMLInputElement>(null);

  const isRexroth = vendor === 'rexroth';
  const isAllenBradley = vendor === 'allenbradley';
  const isSiemens = vendor === 'siemens';
  const credsReady =
    newIp.trim() !== '' && newUser.trim() !== '' && newPass !== '';

  // Reset al cambiar marca
  useEffect(() => {
    setApp('');
    setPrograms([]);
    setProgram('');
    setModalError('');
    setModalHint('');
  }, [vendor]);

  const resetForm = () => {
    setVendor('siemens');
    setNewIp('');
    setSlot('0');
    setS7Transporte('opcua');
    setS7Rack('0');
    setS7Slot('1');
    setS7Tags('');
    setNewUser('');
    setNewPass('');
    setApp('');
    setPrograms([]);
    setProgram('');
    setModalError('');
    setModalHint('');
    setSearching(false);
    setAdding(false);
    setS7Bloques([]);
    setS7Manual(false);
    setS7Pegado('');
  };

  // ---- Siemens/S7comm: importar las fuentes de TIA ----
  //
  // Se leen los ficheros en el navegador y se mandan como texto: el backend
  // calcula los offsets y sondea el PLC para saber qué DB existen. Lo que
  // vuelve se enseña como una lista de variables con casillas; la lista
  // "nombre;DB;offset;TIPO" se genera sola al agregar.
  const importarFuentesTia = useCallback(async (lista: FileList | File[] | string) => {
    // Texto pegado del editor del DB, o ficheros .db: el backend distingue.
    const fuentes: { nombre: string; contenido: string }[] = [];
    if (typeof lista === 'string') {
      if (lista.trim() === '') return;
      fuentes.push({ nombre: `Pegado ${s7Bloques.length + 1}`, contenido: lista });
    } else {
      const ficheros = Array.from(lista);
      if (ficheros.length === 0) return;
      fuentes.push(
        ...(await Promise.all(
          ficheros.map(async (f) => ({ nombre: f.name, contenido: await f.text() })),
        )),
      );
    }
    setS7Importando(true);
    setModalError('');
    try {
      const r = await fetch('/siemens/importar', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          host: newIp.trim(),
          rack: Number(s7Rack) || 0,
          slot: Number(s7Slot) || 1,
          fuentes,
        }),
      });
      const data = await r.json().catch(() => null);
      if (!r.ok) {
        throw new Error(
          typeof data?.detail === 'string' ? data.detail : `HTTP ${r.status}`,
        );
      }
      const nuevos: BloqueTia[] = (data?.bloques ?? []).map((b: any) => ({
        nombre: b.nombre,
        clase: b.clase,
        optimizado: !!b.optimizado,
        tamano: b.tamano ?? 0,
        db: b.db ?? null,
        dbComo: b.db_como ?? '',
        avisos: b.avisos ?? [],
        tags: (b.tags ?? []).map((t: any) => ({
          nombre: t.nombre,
          offset: t.offset,
          bit: t.bit,
          tipo: t.tipo,
          longitud: t.longitud ?? 0,
          marcado: true,
        })),
      }));
      // Se acumulan: subir el UDT después del DB tiene que funcionar igual.
      setS7Bloques((prev) => {
        const porNombre = new Map(prev.map((b) => [b.nombre, b]));
        for (const b of nuevos) porNombre.set(b.nombre, b);
        return Array.from(porNombre.values());
      });
      const avisos: string[] = data?.avisos ?? [];
      if (avisos.length) setModalHint(avisos.join(' '));
      if (typeof lista === 'string') setS7Pegado('');
    } catch (e: any) {
      setModalError(e?.message ?? String(e));
    } finally {
      setS7Importando(false);
      if (s7FicherosRef.current) s7FicherosRef.current.value = '';
    }
  }, [newIp, s7Rack, s7Slot, s7Bloques.length]);

  // La lista que va al backend, en el formato que entiende el driver.
  const s7TagsDesdeBloques = useCallback((): string => {
    const lineas: string[] = [];
    for (const b of s7Bloques) {
      if (b.optimizado || b.db === null) continue;
      for (const tg of b.tags) {
        if (!tg.marcado) continue;
        const off = tg.tipo === 'BOOL' ? `${tg.offset}.${tg.bit}` : String(tg.offset);
        const tipo = tg.tipo === 'STRING' ? `STRING[${tg.longitud}]` : tg.tipo;
        lineas.push(`${tg.nombre};DB${b.db};${off};${tipo}`);
      }
    }
    return lineas.join('\n');
  }, [s7Bloques]);

  const openModal = () => {
    resetForm();
    setShowModal(true);
  };

  // ---- Rexroth: buscar programas (app autodetectada) ----
  const buscarProgramas = useCallback(async () => {
    if (!credsReady) {
      setModalError(t('login.needCreds'));
      return;
    }
    setModalError('');
    setSearching(true);
    setModalHint(t('login.searching'));
    setPrograms([]);
    setProgram('');
    setApp('');
    try {
      const result = await fetchRexrothPrograms({
        ip: newIp,
        usuario: newUser,
        password: newPass,
      });
      setApp(result.app);
      setPrograms(result.programas);
      setModalHint(
        `${result.programas.length} ${t('login.programsFound')}` +
        (result.app ? ` (${result.app})` : ''),
      );
      if (result.programas.length === 1) setProgram(result.programas[0]);
    } catch (e: any) {
      setModalError(e?.message ?? String(e));
      setModalHint('');
    } finally {
      setSearching(false);
    }
  }, [credsReady, newIp, newUser, newPass, t]);

  // ---- Siemens: ¿qué CPU es y por dónde se le puede hablar? ----
  //
  // Pregunta por S7comm (puerto 102, responde cualquier S7 aunque el OPC UA
  // no exista) y mira si hay algo en el 4840. Con eso dice el modelo real
  // —"CPU 1214C", no "S7-1500" por defecto— y preselecciona el transporte.
  const identificarSiemens = useCallback(async () => {
    if (newIp.trim() === '') return;
    setSearching(true);
    setModalError('');
    setModalHint('');
    try {
      const r = await fetch('/siemens/identificar', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ host: newIp.trim(), rack: Number(s7Rack) || 0 }),
      });
      const data = await r.json().catch(() => null);
      if (!r.ok) {
        throw new Error(
          typeof data?.detail === 'string' ? data.detail : `HTTP ${r.status}`,
        );
      }
      if (data?.transporte_sugerido === 's7comm' || data?.transporte_sugerido === 'opcua') {
        setS7Transporte(data.transporte_sugerido);
      }
      if (typeof data?.slot === 'number') setS7Slot(String(data.slot));
      const cabecera = [data?.modelo, data?.nombre ? `«${data.nombre}»` : '', data?.estado]
        .filter(Boolean)
        .join(' · ');
      setModalHint(`${cabecera ? cabecera + '. ' : ''}${data?.mensaje ?? ''}`);
    } catch (e: any) {
      setModalError(e?.message ?? String(e));
    } finally {
      setSearching(false);
    }
  }, [newIp, s7Rack]);

  // ---- Allen-Bradley: identificar el controlador antes de darlo de alta ----
  //
  // No hay nada que "buscar" como en Rexroth (los tags se suben solos al
  // conectar): esto solo confirma que en esa IP y ese slot hay un Logix y
  // dice cuál es, que es lo que evita dar de alta un PLC que no responde.
  const identificarAb = useCallback(async () => {
    if (newIp.trim() === '') return;
    setSearching(true);
    setModalError('');
    setModalHint('');
    try {
      const r = await fetch('/allenbradley/identificar', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ host: newIp.trim(), slot: Number(slot) || 0 }),
      });
      const data = await r.json().catch(() => null);
      if (!r.ok) {
        throw new Error(
          typeof data?.detail === 'string' ? data.detail : `HTTP ${r.status}`,
        );
      }
      const rev = data?.revision;
      const revTxt =
        rev && typeof rev === 'object' ? ` v${rev.major}.${rev.minor}` : '';
      setModalHint(
        `${data?.producto || 'Logix'}${revTxt} · proyecto «${data?.nombre || '?'}» · ${data?.modo || ''}`,
      );
    } catch (e: any) {
      setModalError(e?.message ?? String(e));
    } finally {
      setSearching(false);
    }
  }, [newIp, slot]);

  // ---- Agregar PLC (POST /plcs) ----
  const agregarPlc = async () => {
    if (isRexroth && !program) {
      setModalError(t('login.needProgram'));
      return;
    }
    const tagsS7 = isSiemens && s7Transporte === 's7comm'
      ? (s7Manual ? s7Tags : s7TagsDesdeBloques())
      : '';
    if (isSiemens && s7Transporte === 's7comm' && tagsS7.trim() === '') {
      setModalError(t('login.needTags'));
      return;
    }
    setModalError('');
    setAdding(true);
    try {
      const body: Record<string, unknown> = {
        host: newIp.trim(),
        // Rexroth: puerto HTTPS del Data Layer, no el 4840 de OPC UA.
        puerto: isRexroth ? 443 : 4840,
        vendor,
      };
      if (isRexroth) {
        body.usuario = newUser.trim();
        body.password = newPass;
        body.app = app || 'Application';
        body.programa = program;
      }
      if (isAllenBradley) {
        body.puerto = 44818;
        body.slot = Number(slot) || 0;
      }
      if (isSiemens) {
        body.transporte = s7Transporte;
        if (s7Transporte === 's7comm') {
          body.puerto = 102;
          body.rack = Number(s7Rack) || 0;
          body.slot = Number(s7Slot) || 1;
          body.s7_tags = tagsS7;
        }
      }
      const r = await fetch('/plcs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await r.json().catch(() => null);
      if (!r.ok || data?.ok === false) {
        throw new Error(
          data?.mensaje ?? data?.detail ?? `HTTP ${r.status}`,
        );
      }
      setShowModal(false);
      resetForm();
      await refreshPlcs();
    } catch (e: any) {
      setModalError(e?.message ?? String(e));
    } finally {
      setAdding(false);
    }
  };

  // ---- Eliminar PLC (DELETE /plcs/:id) ----
  const eliminarPlc = async (plcId: string) => {
    try {
      await fetch(`/plcs/${plcId}`, { method: 'DELETE' });
      setPlcs((prev) => prev.filter((p) => p.plc !== plcId));
    } catch {
      /* ignore */
    }
  };

  // ---------- Agrupar PLCs por marca ----------
  const siemensPlcs = plcs.filter(
    (p) => p.vendor === 'siemens' || !p.vendor,
  );
  const rexrothPlcs = plcs.filter((p) => p.vendor === 'rexroth');
  const allenBradleyPlcs = plcs.filter((p) => p.vendor === 'allenbradley');

  const canAdd = !adding && newIp.trim() !== '' && (!isRexroth || !!program);

  // ---------- Agrupar variables por PLC ----------
  const varGroups = React.useMemo(() => {
    const map = new Map<string, typeof variables>();
    for (const v of variables) {
      const sep = v.id.indexOf('|');
      const plcId = sep > 0 ? v.id.slice(0, sep) : '_unknown';
      const arr = map.get(plcId);
      if (arr) arr.push(v);
      else map.set(plcId, [v]);
    }
    return Array.from(map.entries()).map(([plcId, vars]) => {
      const info = plcs.find((p) => p.plc === plcId);
      const vendorLabel = marcaDe(info?.vendor ?? 'siemens');
      const ip = info ? ipDe(info.endpoint) : plcId;
      return {
        plcId,
        label: `${vendorLabel} — ${ip}`,
        vars,
        tagCount: vars.length,
      };
    });
  }, [variables, plcs]);

  // ---------- Opciones de rate ----------
  const rateOptions = UPDATE_RATE_OPTIONS.map((o) =>
    o.value >= 1000 ? { label: t(`rate.${o.value}`), value: o.value } : o,
  );

  const handleSave = () => {
    saveConfig();
    setSaved(true);
    setTimeout(() => setSaved(false), 2200);
  };

  // ── Derivados de PRESENTACIÓN ────────────────────────────────────────
  // Todo lo de aquí abajo se calcula a partir de `plcs` y `varGroups`, que
  // ya existían. No hay ni una petición nueva.

  // Controlador elegido. Si no hay ninguno —primera carga, o se borró el
  // que estaba— cae sobre el primero CONECTADO, que es el que tiene algo
  // que enseñar; si no hay ninguno conectado, sobre el primero de la lista.
  useEffect(() => {
    if (plcs.length === 0) { setPlcSel(''); return; }
    if (plcSel && plcs.some((p) => p.plc === plcSel)) return;
    setPlcSel((plcs.find((p) => p.conectado) ?? plcs[0]).plc);
  }, [plcs, plcSel]);

  const plcInfoSel = plcs.find((p) => p.plc === plcSel) ?? null;
  const grupoSel = varGroups.find((g) => g.plcId === plcSel) ?? null;

  const varsFiltradas = useMemo(() => {
    const q = buscaVar.trim().toLowerCase();
    const vars = grupoSel?.vars ?? [];
    return q ? vars.filter((v) => v.name.toLowerCase().includes(q)) : vars;
  }, [grupoSel, buscaVar]);

  const marcadasDelSel = (grupoSel?.vars ?? []).filter((v) => v.selected);

  /**
   * Lo que se enseña en «Lectura en vivo», ya filtrado por el buscador.
   *
   * Comparte el buscador con la tabla a propósito: son dos vistas de lo
   * mismo, una para marcar y otra para comprobar el valor. Con buscadores
   * separados habría que escribir dos veces lo mismo, y con 206 tags eso
   * se nota. Escribes «bVar1» y las dos se quedan en esas.
   */
  const vivoFiltrado = useMemo(() => {
    const q = buscaVar.trim().toLowerCase();
    return q ? marcadasDelSel.filter((v) => v.name.toLowerCase().includes(q)) : marcadasDelSel;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [grupoSel, buscaVar]);

  // Marcar o quitar de golpe lo que se está viendo. Usa el MISMO
  // `toggleVariable` de siempre, una vez por variable: no hay un camino
  // nuevo, solo se ahorra el clic repetido.
  const marcarTodas = (valor: boolean) => {
    for (const v of varsFiltradas) {
      if (v.selected !== valor) toggleVariable(v.id, valor);
    }
  };

  const plcsEnLinea = plcs.filter((p) => p.conectado).length;

  // Cuántas variables se están mostrando por PLC, para la tarjeta lateral.
  const enUsoPorPlc = useMemo(() => {
    const m = new Map<string, number>();
    for (const g of varGroups) {
      m.set(g.plcId, g.vars.filter((v) => v.selected).length);
    }
    return m;
  }, [varGroups]);

  // =========================================================================
  // Render
  // =========================================================================
  return (
    <div className="flex h-full w-full overflow-hidden bg-slate-50 dark:bg-navy">

      {/* ══════════════════════════════════════════════════════════ */}
      {/* Panel lateral                                              */}
      {/* ══════════════════════════════════════════════════════════ */}
      <aside className="hidden w-56 shrink-0 flex-col border-r border-slate-200 bg-white dark:border-navy-slate dark:bg-navy-soft md:flex">

        {/* La marca. Sigue llevando al menú al pulsarla —un logotipo que
            vuelve al inicio es de lo más común— pero ya NO se transforma en
            una flecha al pasar el ratón: la vuelta de verdad es la flecha de
            la barra superior, que se ve sin tener que descubrir nada. Un
            icono que cambia de identidad al pasar por encima solo lo
            encuentra quien ya sabe que está ahí. */}
        <div className="flex items-center gap-2.5 border-b border-slate-200 px-4 py-4 dark:border-navy-slate">
          <button
            onClick={() => navigate('/menu')}
            title="Volver al menú"
            aria-label="Volver al menú"
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-siemens/10 text-siemens outline-none transition hover:bg-siemens hover:text-white focus-visible:ring-2 focus-visible:ring-siemens/40"
          >
            <MonitorIcon className="h-4 w-4" />
          </button>
          <div className="min-w-0">
            <p className="truncate text-[13px] font-bold text-navy dark:text-slate-100">
              Psi Core
            </p>
            <p className="truncate text-[11px] text-slate-400">
              {t('config.title')}
            </p>
          </div>
        </div>

        <nav className="flex-1 space-y-1 p-2.5">
          <p className="px-2 pb-1.5 pt-1 text-[10px] font-bold uppercase tracking-wider text-slate-400">
            {t('config.title')}
          </p>
          <ItemNav
            activo={seccion === 'controladores'}
            onClick={() => setSeccion('controladores')}
            icon={CpuIcon}
            label={t('config.plcConnection')}
            badge={plcs.length ? `${plcsEnLinea}/${plcs.length}` : '0'}
            alerta={plcs.length > 0 && plcsEnLinea < plcs.length}
          />
          <ItemNav
            activo={seccion === 'escritura'}
            onClick={() => setSeccion('escritura')}
            icon={PencilIcon}
            label="Escritura"
            badge={String(escrituraCuenta.habilitados)}
          />
          <ItemNav
            activo={seccion === 'bd'}
            onClick={() => setSeccion('bd')}
            icon={DatabaseIcon}
            label="Bases de datos"
            badge={String(bdCuenta.total)}
            alerta={bdCuenta.total > bdCuenta.conectadas}
          />
          <ItemNav
            activo={seccion === 'sistema'}
            onClick={() => setSeccion('sistema')}
            icon={SlidersHorizontalIcon}
            label="Sistema"
            badge={`${selectedCount} vars`}
          />
        </nav>

        {/* Pie: que el servicio responda es la primera pregunta cuando algo
            no va, y tenerla siempre a la vista ahorra el viaje a /health. */}
        <div className="border-t border-slate-200 px-4 py-3 dark:border-navy-slate">
          <p className="flex items-center gap-1.5 text-[11px] font-semibold text-state-ok">
            <span className="h-1.5 w-1.5 rounded-full bg-state-ok" />
            Servicio activo
          </p>
          <p className="mt-0.5 truncate font-mono text-[10.5px] text-slate-400">
            {window.location.host}
          </p>
        </div>
      </aside>

      {/* ══════════════════════════════════════════════════════════ */}
      {/* Columna de contenido                                       */}
      {/* ══════════════════════════════════════════════════════════ */}
      <div className="flex min-w-0 flex-1 flex-col">

        {/* ── Barra superior ─────────────────────────────────────── */}
        <header className="flex shrink-0 flex-wrap items-center justify-between gap-x-4 gap-y-3 border-b border-slate-200 bg-white px-5 py-3 dark:border-navy-slate dark:bg-navy-soft">
          <div className="flex min-w-0 items-center gap-3">
            {/* VOLVER AL MENÚ. Antes esto llevaba `md:hidden` —solo salía en
                móvil— porque en escritorio ya estaba la flecha del panel
                lateral. Pero aquella solo aparece al pasar el ratón por
                encima del icono de la marca, así que en pantalla grande no
                había NADA que se leyera como "volver": para salir de
                Configuración había que descubrir que un logotipo era un
                botón, o usar el botón atrás del navegador.

                Ahora está siempre, en el mismo sitio y con la misma pinta que
                en Alarmas, Usuarios, Actividad y el Diseñador. Una flecha en
                la esquina superior izquierda no se busca: se sabe dónde
                está. */}
            <button
              onClick={() => navigate('/menu')}
              title="Volver al menú"
              aria-label="Volver al menú"
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-slate-500 outline-none transition hover:bg-slate-100 hover:text-navy focus-visible:ring-2 focus-visible:ring-siemens/40 dark:hover:bg-navy-slate/40 dark:hover:text-slate-100"
            >
              <ArrowLeftIcon className="h-5 w-5" />
            </button>
            <div className="min-w-0">
              <h1 className="truncate text-[17px] font-bold leading-tight text-navy dark:text-slate-100">
                {t('config.title')}
              </h1>
              <p className="truncate text-[11.5px] text-slate-400">
                {t('config.subtitle')}
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <ChipDato
              icon={<CpuIcon className="h-3.5 w-3.5" />}
              valor={`${plcsEnLinea}/${plcs.length}`}
              etiqueta={plcs.length === 1 ? 'PLC en línea' : 'PLC en línea'}
              alerta={plcs.length > 0 && plcsEnLinea === 0}
            />
            <ChipDato
              icon={<TagIcon className="h-3.5 w-3.5" />}
              valor={String(selectedCount)}
              etiqueta="variables activas"
            />
            <ChipDato
              icon={<DatabaseIcon className="h-3.5 w-3.5" />}
              valor={`${bdCuenta.conectadas}/${bdCuenta.total}`}
              etiqueta="bases conectadas"
              alerta={bdCuenta.total > 0 && bdCuenta.conectadas === 0}
            />
            <button
              onClick={() => void refreshPlcs()}
              className="flex min-h-[34px] items-center gap-1.5 rounded-lg border border-slate-200 px-3 text-xs font-semibold text-slate-600 outline-none transition hover:bg-slate-100 focus-visible:ring-2 focus-visible:ring-siemens/40 dark:border-navy-slate dark:text-slate-300 dark:hover:bg-navy-slate/40"
            >
              <RefreshCwIcon className="h-3.5 w-3.5" />
              Refrescar
            </button>
          </div>
        </header>

        {/* ── Contenido de la sección ────────────────────────────── */}
        <main className="mp-scroll mp-scroll-dark flex-1 overflow-auto p-5">

          {/* ═════════════ CONTROLADORES ═════════════ */}
          {seccion === 'controladores' && (
            <>
              <CabeceraSeccion
                icon={<CpuIcon className="h-4.5 w-4.5" />}
                titulo={t('config.plcConnection')}
                descripcion="Elige un PLC para ver y marcar sus variables. El estado y los valores se actualizan en el acto, en cuanto cambian en el PLC."
                acciones={
                  <button
                    onClick={openModal}
                    className="flex min-h-[36px] items-center gap-1.5 rounded-lg bg-siemens px-3.5 text-xs font-semibold text-white shadow-sm outline-none transition hover:bg-siemens-600 focus-visible:ring-2 focus-visible:ring-siemens/50"
                  >
                    <PlusIcon className="h-4 w-4" />
                    {t('config.addPlc')}
                  </button>
                }
              />

              {plcs.length === 0 ? (
                <Tarjeta className="flex items-center gap-3 px-5 py-8">
                  <WifiOffIcon className="h-6 w-6 shrink-0 text-slate-400" />
                  <div>
                    <p className="text-sm font-semibold text-slate-500 dark:text-slate-300">
                      {t('config.noPlc')}
                    </p>
                    <p className="mt-0.5 text-xs text-slate-400">
                      Pulsa «{t('config.addPlc')}» para dar de alta el primero.
                    </p>
                  </div>
                </Tarjeta>
              ) : (
                /* Maestro-detalle en tres columnas: lista de PLCs, variables
                   del elegido, y ficha del enlace. Antes se apilaban TODOS
                   los grupos de variables de TODOS los PLCs, y con dos
                   controladores la página ya no cabía en pantalla. */
                /* `items-start`: CADA COLUMNA MIDE LO SUYO.
                   Una rejilla estira por defecto todas las columnas a la
                   más alta. Aquí la más alta es la de la derecha (Enlace +
                   Lectura en vivo), así que la tarjeta de variables se
                   estiraba a ~790 px: o le sobraba medio panel vacío
                   debajo de la tabla, o la tabla se estiraba hasta ahí.
                   Las dos cosas se ven mal, y las dos salían de este
                   estirado, no de la tabla. */
                <div className="grid items-start gap-4 xl:grid-cols-[minmax(240px,280px)_minmax(0,1fr)] 2xl:grid-cols-[minmax(240px,280px)_minmax(0,1fr)_minmax(240px,300px)]">

                  {/* ── Lista de controladores ── */}
                  <div className="space-y-4">
                    {[
                      { titulo: VENDOR_LABEL.rexroth, lista: rexrothPlcs },
                      { titulo: VENDOR_LABEL.allenbradley, lista: allenBradleyPlcs },
                      { titulo: VENDOR_LABEL.siemens, lista: siemensPlcs },
                    ]
                      .filter((g) => g.lista.length > 0)
                      .map((g) => (
                        <div key={g.titulo}>
                          <div className="mb-2 flex items-baseline justify-between gap-2 px-0.5">
                            <p className="truncate text-[10.5px] font-bold uppercase tracking-wider text-slate-400">
                              {g.titulo}
                            </p>
                            <span className="shrink-0 text-[10.5px] tabular-nums text-slate-400">
                              {g.lista.length} PLC{g.lista.length === 1 ? '' : 's'}
                            </span>
                          </div>
                          <div className="space-y-2">
                            {g.lista.map((p) => (
                              <TarjetaPlc
                                key={p.plc}
                                plc={p}
                                activo={p.plc === plcSel}
                                enUso={enUsoPorPlc.get(p.plc) ?? 0}
                                onClick={() => { setPlcSel(p.plc); setBuscaVar(''); }}
                                t={t}
                              />
                            ))}
                          </div>
                        </div>
                      ))}
                  </div>

                  {/* ── Variables del PLC elegido ── */}
                  <Tarjeta className="flex flex-col">
                    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-slate-200 px-4 py-3 dark:border-navy-slate">
                      <div className="min-w-0">
                        <h3 className="truncate text-[13.5px] font-bold text-navy dark:text-slate-100">
                          {plcInfoSel ? `Variables de ${plcInfoSel.plc}` : 'Variables'}
                        </h3>
                        <p className="truncate text-[11px] text-slate-400">
                          {plcInfoSel
                            ? `${marcaDe(plcInfoSel.vendor)} · ${ipDe(plcInfoSel.endpoint)}`
                            : 'Elige un controlador de la lista'}
                        </p>
                      </div>
                      <span className="shrink-0 rounded-full bg-siemens-50 px-2.5 py-1 text-[11px] font-semibold text-siemens ring-1 ring-siemens/20 dark:bg-siemens/15 dark:text-siemens-200">
                        {marcadasDelSel.length} {t('config.selected')}
                      </span>
                    </div>

                    {!grupoSel || grupoSel.vars.length === 0 ? (
                      <div className="px-4 py-12 text-center">
                        <TagIcon className="mx-auto mb-3 h-7 w-7 text-slate-300 dark:text-slate-600" />
                        <p className="text-sm font-semibold text-slate-500 dark:text-slate-300">
                          Sin variables todavía
                        </p>
                        <p className="mx-auto mt-1 max-w-sm text-xs leading-relaxed text-slate-400">
                          Aparecen solas en cuanto el controlador conecta y termina
                          su descubrimiento de tags.
                        </p>
                      </div>
                    ) : (
                      <>
                        <div className="flex flex-wrap items-center gap-2 border-b border-slate-100 px-4 py-2.5 dark:border-navy-slate/60">
                          <div className="relative min-w-0 flex-1">
                            <SearchIcon className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
                            <input
                              type="search"
                              value={buscaVar}
                              onChange={(e) => setBuscaVar(e.target.value)}
                              placeholder="Buscar variable…"
                              aria-label="Buscar variable por nombre"
                              className="w-full rounded-lg border border-slate-200 bg-white py-1.5 pl-9 pr-3 text-xs text-navy outline-none transition placeholder:text-slate-400 focus:border-siemens focus:ring-2 focus:ring-siemens/20 dark:border-navy-slate dark:bg-navy dark:text-slate-100"
                            />
                          </div>
                          <button
                            onClick={() => marcarTodas(true)}
                            className="rounded-lg border border-slate-200 px-2.5 py-1.5 text-[11px] font-semibold text-slate-500 outline-none transition hover:bg-slate-100 focus-visible:ring-2 focus-visible:ring-siemens/40 dark:border-navy-slate dark:text-slate-400 dark:hover:bg-navy-slate/40"
                          >
                            Marcar todas
                          </button>
                          <button
                            onClick={() => marcarTodas(false)}
                            className="rounded-lg border border-slate-200 px-2.5 py-1.5 text-[11px] font-semibold text-slate-500 outline-none transition hover:bg-slate-100 focus-visible:ring-2 focus-visible:ring-siemens/40 dark:border-navy-slate dark:text-slate-400 dark:hover:bg-navy-slate/40"
                          >
                            Quitar todas
                          </button>
                        </div>

                        {/* Mismo tope que «Lectura en vivo» (26rem), a
                            propósito: las dos son listas largas que se
                            desplazan por dentro, y con el mismo alto las dos
                            columnas quedan a la par en vez de una el doble
                            de larga que la otra. */}
                        <div className="mp-scroll mp-scroll-dark max-h-[26rem] overflow-auto">
                          <table className="w-full min-w-[440px] text-left text-sm">
                            <thead className="sticky top-0 z-10">
                              <tr>
                                <Th className="w-11">
                                  <span className="sr-only">{t('config.selectVar')}</span>
                                </Th>
                                <Th>{t('config.colName')}</Th>
                                <Th className="w-24">{t('config.colType')}</Th>
                                <Th className="w-32 text-right">{t('config.colValue')}</Th>
                              </tr>
                            </thead>
                            <tbody>
                              {varsFiltradas.map((v) => (
                                <tr
                                  key={v.id}
                                  className="border-b border-slate-100 transition-colors last:border-0 hover:bg-slate-50/70 dark:border-navy-slate/50 dark:hover:bg-navy/40"
                                >
                                  <td className="py-2 pl-4 pr-0">
                                    <input
                                      type="checkbox"
                                      checked={v.selected}
                                      onChange={(e) => toggleVariable(v.id, e.target.checked)}
                                      className="h-4 w-4 cursor-pointer rounded border-slate-300 accent-siemens dark:border-navy-slate"
                                      aria-label={`${t('config.selectVar')} ${v.name}`}
                                    />
                                  </td>
                                  <td
                                    className="max-w-[18rem] truncate px-4 py-2 font-mono text-[12.5px] font-medium text-navy dark:text-slate-100"
                                    title={v.name}
                                  >
                                    {v.name}
                                  </td>
                                  <td className="px-4 py-2">
                                    <span
                                      className={`rounded-md px-2 py-0.5 text-[11px] font-semibold ring-1 ${typeColor[v.type]}`}
                                    >
                                      {Array.isArray(v.value)
                                        ? `${v.type}[${v.value.length}]`
                                        : v.type}
                                    </span>
                                  </td>
                                  {/* tabular-nums: sin esto las cifras bailan
                                      de fila en fila y la columna deja de
                                      leerse como una columna.
                                      `max-w` + `truncate`: la celda NUNCA
                                      decide el ancho de la tabla. Un valor
                                      largo (un array, un texto) se corta y
                                      el completo va en el tooltip. */}
                                  <td
                                    className="max-w-[14rem] truncate px-4 py-2 text-right font-mono text-xs tabular-nums text-slate-600 dark:text-slate-300"
                                    title={formatValueFull(v)}
                                  >
                                    {formatValue(v)}
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>

                          {varsFiltradas.length === 0 && (
                            <p className="px-4 py-8 text-center text-xs text-slate-400">
                              Ninguna variable coincide con «{buscaVar}».
                            </p>
                          )}
                        </div>
                      </>
                    )}

                    <p className="mt-auto flex items-start gap-2 border-t border-slate-100 bg-slate-50/70 px-4 py-2.5 text-[11px] leading-relaxed text-slate-400 dark:border-navy-slate dark:bg-navy/40">
                      <InfoIcon className="mt-px h-3.5 w-3.5 shrink-0" />
                      <span className="min-w-0">
                        {t('config.onlySelected')} {t('config.mainView')}.
                      </span>
                    </p>
                  </Tarjeta>

                  {/* ── Ficha del enlace + lectura en vivo ── */}
                  <div className="hidden space-y-4 2xl:block">
                    {plcInfoSel && (
                      <>
                        <Tarjeta>
                          <div className="flex items-center gap-2 border-b border-slate-200 px-4 py-2.5 dark:border-navy-slate">
                            <Link2Icon className="h-3.5 w-3.5 text-siemens" />
                            <h3 className="text-[12px] font-bold text-navy dark:text-slate-100">
                              Enlace
                            </h3>
                          </div>
                          <FilaDato etiqueta="Estado">
                            <ChipEstado
                              ok={plcInfoSel.conectado}
                              si={t('config.plcOnline')}
                              no={t('config.plcOffline')}
                            />
                          </FilaDato>
                          <FilaDato etiqueta="Marca">{marcaDe(plcInfoSel.vendor)}</FilaDato>
                          {plcInfoSel.modelo && (
                            <FilaDato etiqueta="Modelo">
                              <span className="font-mono text-[12px]">{plcInfoSel.modelo}</span>
                            </FilaDato>
                          )}
                          <FilaDato etiqueta="Dirección">
                            <span className="font-mono text-[12px]">
                              {ipDe(plcInfoSel.endpoint)}
                            </span>
                          </FilaDato>
                          <FilaDato etiqueta={t('config.readMode')}>
                            <span className="font-mono text-[12px]">
                              {plcInfoSel.modo_lectura}
                            </span>
                          </FilaDato>
                          <FilaDato etiqueta="Muestreo">
                            <span className="font-mono text-[12px] tabular-nums">
                              {plcInfoSel.sampling_interval_ms} ms
                            </span>
                          </FilaDato>
                          {/* «Desconectado» a secas no dice nada. El último
                              fallo del driver sí: "connection refused en el
                              4840", "Object does not exist" en un DB
                              optimizado... es lo que hay que leer para saber
                              qué tocar en TIA. */}
                          {!plcInfoSel.conectado && plcInfoSel.ultimo_error && (
                            <div className="border-t border-slate-100 px-3 py-2.5 dark:border-navy-slate/60">
                              <p className="mb-1 text-[10.5px] font-bold uppercase tracking-wider text-state-error">
                                Último error
                              </p>
                              <p className="break-words text-[11.5px] leading-relaxed text-slate-600 dark:text-slate-300">
                                {plcInfoSel.ultimo_error}
                              </p>
                            </div>
                          )}

                          <div className="border-t border-slate-100 p-3 dark:border-navy-slate/60">
                            <button
                              onClick={() => eliminarPlc(plcInfoSel.plc)}
                              className="flex w-full items-center justify-center gap-1.5 rounded-lg border border-state-error/30 px-3 py-2 text-[11.5px] font-semibold text-state-error outline-none transition hover:bg-state-error/10 focus-visible:ring-2 focus-visible:ring-state-error/40"
                            >
                              <Trash2Icon className="h-3.5 w-3.5" />
                              {t('config.removePlc')}
                            </button>
                          </div>
                        </Tarjeta>

                        {/* Lectura en vivo: SOLO lo marcado. Es la
                            comprobación de "¿lo que elegí es lo que quería?"
                            sin tener que irse al Diseñador a mirarlo. */}
                        {marcadasDelSel.length > 0 && (
                          <Tarjeta>
                            <div className="flex items-center justify-between gap-2 border-b border-slate-200 px-4 py-2.5 dark:border-navy-slate">
                              <span className="flex items-center gap-2">
                                <ActivityIcon className="h-3.5 w-3.5 text-siemens" />
                                <h3 className="text-[12px] font-bold text-navy dark:text-slate-100">
                                  Lectura en vivo
                                </h3>
                              </span>
                              <span className="text-[11px] tabular-nums text-slate-400">
                                {vivoFiltrado.length === marcadasDelSel.length
                                  ? marcadasDelSel.length
                                  : `${vivoFiltrado.length} / ${marcadasDelSel.length}`}
                              </span>
                            </div>
                            {/* TOPE DE ALTURA Y SCROLL PROPIO.
                                Antes pintaba las 206 seguidas sin tope: la
                                tarjeta crecía metros, y como las dos columnas
                                de la fila se estiran a la más alta, la tabla
                                de la izquierda se quedaba con medio metro de
                                hueco vacío debajo. Con el tope, el panel se
                                desplaza por dentro y la fila vuelve a medir
                                lo que mide la tabla. */}
                            <div className="mp-scroll mp-scroll-dark max-h-[26rem] overflow-y-auto">
                            <div className="grid grid-cols-2 gap-px bg-slate-100 dark:bg-navy-slate/60">
                              {vivoFiltrado.map((v) => (
                                <div
                                  key={v.id}
                                  className="bg-white px-3 py-2.5 dark:bg-navy-soft"
                                >
                                  <p className="truncate font-mono text-[10.5px] text-slate-400">
                                    {v.name.split('.').pop()}
                                  </p>
                                  <p className="truncate font-mono text-[13px] font-bold tabular-nums text-navy dark:text-slate-100">
                                    {formatValue(v)}
                                  </p>
                                </div>
                              ))}
                            </div>

                            {vivoFiltrado.length === 0 && (
                              <p className="px-4 py-6 text-center text-[11px] text-slate-400">
                                Ninguna variable marcada coincide con «{buscaVar}».
                              </p>
                            )}
                            </div>
                          </Tarjeta>
                        )}
                      </>
                    )}
                  </div>
                </div>
              )}
            </>
          )}

          {/* ═════════════ ESCRITURA ═════════════ */}
          {seccion === 'escritura' && (
            <>
              <CabeceraSeccion
                icon={<PencilIcon className="h-4.5 w-4.5" />}
                titulo="Escritura en el PLC"
                descripcion="El HMI solo escribe en los tags dados de alta aquí, y dentro de los límites que les pongas. Todo lo demás se rechaza aunque el PLC lo permita."
              />
              <PanelEscritura
                plcs={plcs.map((p) => ({
                  id: p.plc,
                  nombre: p.nombre || p.plc,
                  conectado: p.conectado
                }))}
                onEstado={setEscrituraCuenta}
                buscaInicial={tagBuscado}
              />
            </>
          )}

          {/* ═════════════ BASES DE DATOS ═════════════ */}
          {seccion === 'bd' && (
            <>
              <CabeceraSeccion
                icon={<DatabaseIcon className="h-4.5 w-4.5" />}
                titulo="Bases de datos"
                descripcion="Cada base tiene sus propias cuentas, alarmas y recetas. La que use el login se elige al entrar."
              />
              <PanelBasesDatos onEstado={setBdCuenta} />
            </>
          )}

          {/* ═════════════ SISTEMA ═════════════ */}
          {seccion === 'sistema' && (
            <>
              <CabeceraSeccion
                icon={<SlidersHorizontalIcon className="h-4.5 w-4.5" />}
                titulo={t('config.general')}
                descripcion="Ajustes de esta vista y de este navegador, y dónde vive la configuración de este equipo."
                acciones={
                  <button
                    onClick={handleSave}
                    className="flex min-h-[36px] items-center gap-1.5 rounded-lg bg-siemens px-3.5 text-xs font-semibold text-white shadow-sm outline-none transition hover:bg-siemens-600 focus-visible:ring-2 focus-visible:ring-siemens/50"
                  >
                    <SaveIcon className="h-4 w-4" />
                    {t('config.save')}
                  </button>
                }
              />

              <div className="grid gap-5 xl:grid-cols-2">
                <div>
                  <h3 className="mb-2 px-0.5 text-[10.5px] font-bold uppercase tracking-wider text-slate-400">
                    Ajustes generales
                  </h3>
                  <Tarjeta>
                    <FilaAjuste
                      titulo={t('config.updateRate')}
                      descripcion="Cada cuánto se repintan los valores en pantalla."
                      value={config.updateRate}
                      options={rateOptions}
                      onChange={setUpdateRate}
                    />
                    <FilaAjuste
                      titulo={t('config.theme')}
                      descripcion="Apariencia de la interfaz en este navegador."
                      value={config.theme}
                      options={[
                        { label: t('config.themeLight'), value: 'light' as const },
                        { label: t('config.themeDark'), value: 'dark' as const },
                        { label: t('config.themeAuto'), value: 'auto' as const },
                      ]}
                      onChange={setTheme}
                    />
                    <FilaAjuste
                      titulo={t('config.language')}
                      descripcion="Textos de menús, avisos y mensajes."
                      value={config.language}
                      options={[
                        { label: t('config.langEs'), value: 'es' as const },
                        { label: t('config.langEn'), value: 'en' as const },
                      ]}
                      onChange={setLanguage}
                    />
                  </Tarjeta>

                  <p className="mt-3 flex items-start gap-2 rounded-lg bg-slate-100 px-3 py-2.5 text-[11.5px] leading-relaxed text-slate-500 dark:bg-navy dark:text-slate-400">
                    <InfoIcon className="mt-px h-3.5 w-3.5 shrink-0 text-slate-400" />
                    <span className="min-w-0">
                      Ahora mismo hay{' '}
                      <b className="font-semibold text-navy dark:text-slate-100">
                        {selectedCount} variables
                      </b>{' '}
                      marcadas. {t('config.onlySelected')} {t('config.mainView')}.
                    </span>
                  </p>
                </div>

                <div>
                  <h3 className="mb-2 px-0.5 text-[10.5px] font-bold uppercase tracking-wider text-slate-400">
                    Carpeta de datos
                  </h3>
                  <PanelCarpetaDatos />
                </div>
              </div>
            </>
          )}
        </main>
      </div>

      {/* =============================================================== */}
      {/* Modal: Agregar PLC                                              */}
      {/* =============================================================== */}
      <AnimatePresence>
        {showModal && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm"
            onMouseDown={() => setShowModal(false)}
          >
            <motion.div
              initial={{ opacity: 0, y: 24, scale: 0.96 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 24, scale: 0.96 }}
              transition={{ duration: 0.25, ease: 'easeOut' }}
              className="relative w-full max-w-lg rounded-2xl border border-white/10 bg-navy-soft p-6 shadow-2xl"
              onMouseDown={(e) => e.stopPropagation()}
            >
              {/* Cerrar */}
              <button
                onClick={() => setShowModal(false)}
                className="absolute right-4 top-4 rounded-lg p-1 text-slate-400 transition hover:bg-white/10 hover:text-white"
              >
                <XIcon className="h-5 w-5" />
              </button>

              <h2 className="mb-5 text-lg font-bold text-white">
                {t('config.addPlc')}
              </h2>

              {/* Tabs de marca */}
              <div className="mb-5 grid grid-cols-3 gap-2 rounded-xl border border-white/10 bg-navy/60 p-1">
                {(
                  [
                    ['siemens', t('login.vendorSiemens')],
                    ['rexroth', t('login.vendorRexroth')],
                    ['allenbradley', t('login.vendorAllenBradley')],
                  ] as [PlcVendor, string][]
                ).map(([v, etiqueta]) => (
                  <button
                    key={v}
                    type="button"
                    onClick={() => setVendor(v)}
                    className={`rounded-lg py-2 text-sm font-medium transition ${
                      vendor === v
                        ? 'bg-siemens text-white shadow shadow-siemens/30'
                        : 'text-slate-400 hover:text-slate-200'
                    }`}
                  >
                    {etiqueta}
                  </button>
                ))}
              </div>

              <p className="mb-4 text-[11px] text-slate-500">
                {isRexroth
                  ? t('login.vendorRexrothHint')
                  : isAllenBradley
                    ? t('login.vendorAllenBradleyHint')
                    : t('login.vendorSiemensHint')}
              </p>

              <div className="space-y-3">
                {/* IP (con sufijo :443 para Rexroth: HTTPS del Data Layer) */}
                <div>
                  <span className="mb-1.5 block text-xs font-medium text-slate-400">
                    {t('login.ip')}
                  </span>
                  <div className="flex items-stretch">
                    <input
                      type="text"
                      value={newIp}
                      placeholder="192.168.0.1"
                      onChange={(e) => setNewIp(e.target.value)}
                      className={`flex-1 border border-white/10 bg-navy/60 py-2.5 px-3 text-sm text-white placeholder-slate-500 outline-none transition focus:border-siemens focus:ring-2 focus:ring-siemens/30 ${
                        isRexroth || isAllenBradley ? 'rounded-l-xl' : 'rounded-xl'
                      }`}
                    />
                    {(isRexroth || isAllenBradley) && (
                      <span className="flex items-center rounded-r-xl border border-l-0 border-white/10 bg-navy/80 px-3 text-xs font-mono text-slate-500">
                        {isRexroth ? ':443' : ':44818'}
                      </span>
                    )}
                  </div>
                </div>

                {/* Siemens: identificar + transporte. Un S7-1200 sin OPC UA
                    va por S7comm, y ahí los tags se escriben a mano. */}
                {isSiemens && (
                  <>
                    <button
                      type="button"
                      onClick={identificarSiemens}
                      disabled={searching || newIp.trim() === ''}
                      className="flex w-full items-center justify-center gap-2 rounded-xl border border-white/10 bg-siemens/20 py-2.5 text-sm font-medium text-white transition hover:bg-siemens/30 disabled:opacity-40"
                    >
                      {searching ? (
                        <>
                          <motion.span
                            className="h-4 w-4 rounded-full border-2 border-white/40 border-t-white"
                            animate={{ rotate: 360 }}
                            transition={{ repeat: Infinity, duration: 0.7, ease: 'linear' }}
                          />
                          {t('login.identifying')}
                        </>
                      ) : (
                        <>
                          <SearchIcon className="h-4 w-4" />
                          {t('login.identify')}
                        </>
                      )}
                    </button>
                    {modalHint && (
                      <p className="text-[11px] leading-relaxed text-emerald-400/90">{modalHint}</p>
                    )}

                    <div>
                      <span className="mb-1.5 block text-xs font-medium text-slate-400">
                        {t('login.s7Transport')}
                      </span>
                      <div className="grid grid-cols-2 gap-2 rounded-xl border border-white/10 bg-navy/60 p-1">
                        {(
                          [
                            ['opcua', t('login.s7Opcua')],
                            ['s7comm', t('login.s7comm')],
                          ] as ['opcua' | 's7comm', string][]
                        ).map(([v, etiqueta]) => (
                          <button
                            key={v}
                            type="button"
                            onClick={() => setS7Transporte(v)}
                            className={`rounded-lg py-2 text-sm font-medium transition ${
                              s7Transporte === v
                                ? 'bg-siemens text-white shadow shadow-siemens/30'
                                : 'text-slate-400 hover:text-slate-200'
                            }`}
                          >
                            {etiqueta}
                          </button>
                        ))}
                      </div>
                      <p className="mt-1.5 text-[11px] leading-relaxed text-slate-500">
                        {s7Transporte === 's7comm'
                          ? t('login.s7commHint')
                          : t('login.s7OpcuaHint')}
                      </p>
                    </div>

                    {s7Transporte === 's7comm' && (
                      <>
                        <div className="grid grid-cols-2 gap-3">
                          <ModalInput
                            label={t('login.s7Rack')}
                            value={s7Rack}
                            onChange={(v) => setS7Rack(v.replace(/[^0-9]/g, ''))}
                            placeholder="0"
                          />
                          <ModalInput
                            label={t('login.s7Slot')}
                            value={s7Slot}
                            onChange={(v) => setS7Slot(v.replace(/[^0-9]/g, ''))}
                            placeholder="1"
                          />
                        </div>
                        {/* Variables: desde las fuentes de TIA. Nadie
                            escribe offsets: los calcula el backend. */}
                        <div>
                          <div className="mb-1.5 flex items-center justify-between">
                            <span className="text-xs font-medium text-slate-400">
                              {t('login.s7Import')}
                            </span>
                            <button
                              type="button"
                              onClick={() => setS7Manual((v) => !v)}
                              className="text-[11px] text-slate-500 underline-offset-2 hover:text-slate-300 hover:underline"
                            >
                              {s7Manual ? t('login.s7Import') : t('login.s7Manual')}
                            </button>
                          </div>

                          {s7Manual ? (
                            <>
                              <textarea
                                value={s7Tags}
                                onChange={(e) => setS7Tags(e.target.value)}
                                rows={6}
                                spellCheck={false}
                                placeholder={'temperatura;DB1;0;REAL\nmarcha;DB1;4.0;BOOL\ncontador;DB1;6;DINT\ntexto;DB1;10;STRING[20]'}
                                className="w-full rounded-xl border border-white/10 bg-navy/60 py-2.5 px-3 font-mono text-[12px] leading-relaxed text-white placeholder-slate-600 outline-none transition focus:border-siemens focus:ring-2 focus:ring-siemens/30"
                              />
                              <p className="mt-1 text-[11px] leading-relaxed text-slate-500">
                                {t('login.s7TagsHint')}
                              </p>
                            </>
                          ) : (
                            <>
                              {/* Camino principal: copiar del editor del DB y
                                  pegar. Tres pasos, sin ficheros ni offsets. */}
                              {s7Bloques.length === 0 && (
                                <ol className="mb-2 space-y-1 rounded-xl border border-white/10 bg-navy/40 px-3 py-2.5 text-[11.5px] leading-relaxed text-slate-300">
                                  <li className="font-semibold text-slate-200">{t('login.s7PasteTitle')}</li>
                                  <li><span className="mr-1.5 font-mono text-siemens">1.</span>{t('login.s7PasteStep1')}</li>
                                  <li><span className="mr-1.5 font-mono text-siemens">2.</span>{t('login.s7PasteStep2')}</li>
                                  <li><span className="mr-1.5 font-mono text-siemens">3.</span>{t('login.s7PasteStep3')}</li>
                                </ol>
                              )}
                              <textarea
                                value={s7Pegado}
                                onChange={(e) => setS7Pegado(e.target.value)}
                                onPaste={(e) => {
                                  // Al pegar se lee directamente: sin botón que buscar.
                                  const txt = e.clipboardData.getData('text');
                                  if (txt.trim()) {
                                    e.preventDefault();
                                    setS7Pegado(txt);
                                    void importarFuentesTia(txt);
                                  }
                                }}
                                rows={3}
                                spellCheck={false}
                                placeholder={t('login.s7PastePlaceholder')}
                                className="w-full rounded-xl border border-white/10 bg-navy/60 py-2.5 px-3 font-mono text-[12px] leading-relaxed text-white placeholder-slate-600 outline-none transition focus:border-siemens focus:ring-2 focus:ring-siemens/30"
                              />
                              {s7Pegado.trim() !== '' && !s7Importando && (
                                <button
                                  type="button"
                                  onClick={() => void importarFuentesTia(s7Pegado)}
                                  className="mt-1.5 w-full rounded-xl border border-white/10 bg-siemens/20 py-2 text-xs font-medium text-white transition hover:bg-siemens/30"
                                >
                                  {t('login.s7PasteRead')}
                                </button>
                              )}
                              {s7Importando && (
                                <p className="mt-1.5 flex items-center gap-2 text-[11px] text-slate-400">
                                  <motion.span
                                    className="h-3.5 w-3.5 rounded-full border-2 border-white/40 border-t-white"
                                    animate={{ rotate: 360 }}
                                    transition={{ repeat: Infinity, duration: 0.7, ease: 'linear' }}
                                  />
                                  {t('login.s7Importing')}
                                </p>
                              )}

                              {/* Camino secundario: ficheros .db exportados. */}
                              <input
                                ref={s7FicherosRef}
                                type="file"
                                multiple
                                accept=".db,.udt,.scl,.txt,.awl"
                                className="hidden"
                                onChange={(e) => e.target.files && void importarFuentesTia(e.target.files)}
                              />
                              <button
                                type="button"
                                onClick={() => s7FicherosRef.current?.click()}
                                onDragOver={(e) => { e.preventDefault(); setS7Arrastrando(true); }}
                                onDragLeave={() => setS7Arrastrando(false)}
                                onDrop={(e) => {
                                  e.preventDefault();
                                  setS7Arrastrando(false);
                                  void importarFuentesTia(e.dataTransfer.files);
                                }}
                                disabled={s7Importando}
                                className={`mt-2 flex w-full items-center justify-center gap-2 rounded-xl border border-dashed px-3 py-2 text-center text-[11px] transition ${
                                  s7Arrastrando
                                    ? 'border-siemens bg-siemens/15 text-white'
                                    : 'border-white/15 text-slate-500 hover:border-siemens/60 hover:text-slate-300'
                                } disabled:opacity-50`}
                              >
                                <UploadIcon className="h-3.5 w-3.5" />
                                {t('login.s7ImportDrop')}
                              </button>
                              <p className="mt-1.5 text-[11px] leading-relaxed text-slate-500">
                                {t('login.s7ImportHow')}
                              </p>

                              {s7Bloques.length > 0 && (
                                <div className="mt-3 space-y-2">
                                  {s7Bloques.map((b) => (
                                    <BloqueTiaCard
                                      key={b.nombre}
                                      bloque={b}
                                      t={t}
                                      onDb={(db) =>
                                        setS7Bloques((prev) =>
                                          prev.map((x) => (x.nombre === b.nombre ? { ...x, db } : x)),
                                        )
                                      }
                                      onToggle={(nombreTag, marcado) =>
                                        setS7Bloques((prev) =>
                                          prev.map((x) =>
                                            x.nombre !== b.nombre
                                              ? x
                                              : {
                                                  ...x,
                                                  tags: x.tags.map((tg) =>
                                                    nombreTag === '*' || tg.nombre === nombreTag
                                                      ? { ...tg, marcado }
                                                      : tg,
                                                  ),
                                                },
                                          ),
                                        )
                                      }
                                    />
                                  ))}
                                </div>
                              )}
                            </>
                          )}
                        </div>
                      </>
                    )}
                  </>
                )}

                {/* Allen-Bradley: slot + identificar. Sin usuario ni contraseña:
                    EtherNet/IP no autentica. */}
                {isAllenBradley && (
                  <>
                    <div>
                      <ModalInput
                        label={t('login.slot')}
                        value={slot}
                        onChange={(v) => setSlot(v.replace(/[^0-9]/g, ''))}
                        placeholder="0"
                      />
                      <p className="mt-1 text-[11px] text-slate-500">
                        {t('login.slotHint')}
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={identificarAb}
                      disabled={searching || newIp.trim() === ''}
                      className="flex w-full items-center justify-center gap-2 rounded-xl border border-white/10 bg-siemens/20 py-2.5 text-sm font-medium text-white transition hover:bg-siemens/30 disabled:opacity-40"
                    >
                      {searching ? (
                        <>
                          <motion.span
                            className="h-4 w-4 rounded-full border-2 border-white/40 border-t-white"
                            animate={{ rotate: 360 }}
                            transition={{ repeat: Infinity, duration: 0.7, ease: 'linear' }}
                          />
                          {t('login.identifying')}
                        </>
                      ) : (
                        <>
                          <SearchIcon className="h-4 w-4" />
                          {t('login.identify')}
                        </>
                      )}
                    </button>
                    {modalHint && (
                      <p className="text-[11px] text-emerald-400/90">{modalHint}</p>
                    )}
                  </>
                )}

                {/* Credenciales Rexroth */}
                {isRexroth && (
                  <>
                    <ModalInput
                      label={t('login.user')}
                      value={newUser}
                      onChange={setNewUser}
                      placeholder="boschrexroth"
                    />
                    <ModalInput
                      label={t('login.password')}
                      value={newPass}
                      onChange={setNewPass}
                      placeholder="••••••••"
                      type="password"
                    />

                    {/* Buscar programas (app autodetectada) */}
                    <button
                      type="button"
                      onClick={buscarProgramas}
                      disabled={searching || !credsReady}
                      className="flex w-full items-center justify-center gap-2 rounded-xl border border-white/10 bg-siemens/20 py-2.5 text-sm font-medium text-white transition hover:bg-siemens/30 disabled:opacity-40"
                    >
                      {searching ? (
                        <>
                          <motion.span
                            className="h-4 w-4 rounded-full border-2 border-white/40 border-t-white"
                            animate={{ rotate: 360 }}
                            transition={{ repeat: Infinity, duration: 0.7, ease: 'linear' }}
                          />
                          {t('login.searching')}
                        </>
                      ) : (
                        <>
                          <SearchIcon className="h-4 w-4" />
                          {t('login.search')}
                        </>
                      )}
                    </button>

                    {/* Programa (aparece tras buscar) */}
                    {programs.length > 0 && (
                      <div>
                        <span className="mb-1.5 block text-xs font-medium text-slate-400">
                          {t('login.program')}
                        </span>
                        <ModalSelect
                          value={program}
                          onChange={setProgram}
                          disabled={searching}
                          placeholder={t('login.selectProgram')}
                          options={programs}
                          icon={
                            <FileCodeIcon className="h-4 w-4 text-slate-500" />
                          }
                        />
                      </div>
                    )}

                    {modalHint && (
                      <p className="text-[11px] text-slate-500">
                        {modalHint}
                      </p>
                    )}
                  </>
                )}
              </div>

              {/* Error */}
              {modalError && (
                <div className="mt-4 flex items-start gap-2 rounded-xl border border-red-500/30 bg-red-500/10 p-3">
                  <AlertCircleIcon className="mt-0.5 h-4 w-4 shrink-0 text-red-400" />
                  <p className="whitespace-pre-wrap text-xs text-red-300">
                    {modalError}
                  </p>
                </div>
              )}

              {/* Botón Agregar */}
              <button
                onClick={agregarPlc}
                disabled={!canAdd}
                className="mt-5 flex w-full items-center justify-center gap-2 rounded-xl bg-siemens py-3 text-sm font-semibold text-white shadow-lg shadow-siemens/30 transition-colors hover:bg-siemens-600 disabled:opacity-50"
              >
                {adding ? (
                  <>
                    <motion.span
                      className="h-4 w-4 rounded-full border-2 border-white/40 border-t-white"
                      animate={{ rotate: 360 }}
                      transition={{
                        repeat: Infinity,
                        duration: 0.7,
                        ease: 'linear',
                      }}
                    />
                    {t('login.connecting')}
                  </>
                ) : (
                  <>
                    <PlusIcon className="h-4 w-4" />
                    {t('config.addPlc')}
                  </>
                )}
              </button>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Toast de guardado */}
      <AnimatePresence>
        {saved && (
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 20 }}
            className="fixed bottom-6 left-1/2 flex -translate-x-1/2 items-center gap-2 rounded-xl bg-navy px-4 py-3 text-sm font-medium text-white shadow-xl"
          >
            <CheckCircle2Icon className="h-4 w-4 text-state-ok" />
            {t('config.saved')}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

// =========================================================================
// Componentes auxiliares del modal
// =========================================================================
// ─── Bloque importado de TIA (S7comm) ───────────────────────────
interface TagTia {
  nombre: string;
  offset: number;
  bit: number;
  tipo: string;
  longitud: number;
  marcado: boolean;
}

interface BloqueTia {
  nombre: string;
  clase: string;
  optimizado: boolean;
  tamano: number;
  db: number | null;
  dbComo: string;
  avisos: string[];
  tags: TagTia[];
}

/**
 * Un DB leído de las fuentes de TIA: su número (deducido, editable), sus
 * variables con casilla y sus avisos. Un DB optimizado sale marcado en
 * ámbar y no se agrega: S7comm no lo puede leer.
 */
function BloqueTiaCard({
  bloque,
  onDb,
  onToggle,
  t,
}: {
  bloque: BloqueTia;
  onDb: (db: number | null) => void;
  onToggle: (nombreTag: string, marcado: boolean) => void;
  t: (k: string) => string;
}) {
  const marcados = bloque.tags.filter((x) => x.marcado).length;
  const todos = marcados === bloque.tags.length;
  const direccion = (x: TagTia) =>
    x.tipo === 'BOOL' ? `${x.offset}.${x.bit}` : `${x.offset}`;
  return (
    <div
      className={`rounded-xl border p-3 ${
        bloque.optimizado
          ? 'border-amber-500/40 bg-amber-500/5'
          : 'border-white/10 bg-navy/40'
      }`}
    >
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate font-mono text-[12.5px] font-semibold text-white">
          {bloque.nombre}
        </span>
        <span className="shrink-0 text-[10.5px] text-slate-500">
          {bloque.tamano} B
          {bloque.dbComo && !bloque.optimizado ? ` · DB por ${bloque.dbComo}` : ''}
        </span>
        <label className="flex shrink-0 items-center gap-1 text-[11px] text-slate-400">
          {t('login.s7DbNumber')}
          <input
            type="text"
            inputMode="numeric"
            value={bloque.db ?? ''}
            placeholder="?"
            onChange={(e) => {
              const v = e.target.value.replace(/[^0-9]/g, '');
              onDb(v === '' ? null : Number(v));
            }}
            className={`w-14 rounded-lg border bg-navy/60 px-2 py-1 text-center font-mono text-[12px] text-white outline-none focus:border-siemens ${
              bloque.db === null ? 'border-state-error/60' : 'border-white/10'
            }`}
          />
        </label>
      </div>

      {bloque.avisos.length > 0 && (
        <div className="mt-2 space-y-1">
          {bloque.avisos.map((a, i) => (
            <p key={i} className="flex items-start gap-1.5 text-[11px] leading-relaxed text-amber-300/90">
              <AlertTriangleIcon className="mt-0.5 h-3 w-3 shrink-0" />
              <span>{a}</span>
            </p>
          ))}
        </div>
      )}

      {!bloque.optimizado && bloque.tags.length > 0 && (
        <>
          <div className="mt-2 flex items-center justify-between text-[10.5px] text-slate-500">
            <span>{marcados}/{bloque.tags.length}</span>
            <button
              type="button"
              onClick={() => onToggle('*', !todos)}
              className="hover:text-slate-300"
            >
              {todos ? 'Quitar todas' : 'Marcar todas'}
            </button>
          </div>
          <div className="mp-scroll mp-scroll-dark mt-1 max-h-40 overflow-y-auto rounded-lg border border-white/5">
            {bloque.tags.map((x) => (
              <label
                key={x.nombre}
                className="flex cursor-pointer items-center gap-2 border-b border-white/5 px-2 py-1 text-[11.5px] last:border-b-0 hover:bg-white/5"
              >
                <input
                  type="checkbox"
                  checked={x.marcado}
                  onChange={(e) => onToggle(x.nombre, e.target.checked)}
                  className="h-3.5 w-3.5 accent-siemens"
                />
                <span className="min-w-0 flex-1 truncate font-mono text-slate-200">{x.nombre}</span>
                <span className="shrink-0 font-mono text-[10.5px] text-slate-500">
                  {x.tipo === 'STRING' ? `STRING[${x.longitud}]` : x.tipo}
                </span>
                <span className="w-12 shrink-0 text-right font-mono text-[10.5px] tabular-nums text-slate-500">
                  {direccion(x)}
                </span>
              </label>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function ModalInput({
  label,
  value,
  onChange,
  placeholder,
  type,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  type?: string;
}) {
  return (
    <div>
      <span className="mb-1.5 block text-xs font-medium text-slate-400">
        {label}
      </span>
      <input
        type={type ?? 'text'}
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        className="w-full rounded-xl border border-white/10 bg-navy/60 py-2.5 px-3 text-sm text-white placeholder-slate-500 outline-none transition focus:border-siemens focus:ring-2 focus:ring-siemens/30"
      />
    </div>
  );
}

function ModalSelect({
  value,
  onChange,
  options,
  placeholder,
  icon,
  disabled,
}: {
  value: string;
  onChange: (v: string) => void;
  options: string[];
  placeholder: string;
  icon: React.ReactNode;
  disabled?: boolean;
}) {
  return (
    <div className="relative flex-1">
      <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2">
        {icon}
      </span>
      <select
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        className="w-full appearance-none rounded-xl border border-white/10 bg-navy/60 py-2.5 pl-10 pr-3 text-sm text-white outline-none transition focus:border-siemens focus:ring-2 focus:ring-siemens/30 disabled:opacity-50"
      >
        <option value="" disabled>
          {placeholder}
        </option>
        {options.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
    </div>
  );
}
