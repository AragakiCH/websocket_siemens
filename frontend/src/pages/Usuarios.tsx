// =========================================================================
// Usuarios.tsx  —  Gestión de cuentas
//
// La vista del CRUD que ya expone `/auth/usuarios/*`. Hasta ahora las cuentas
// solo se podían crear desde el registro inicial o a mano contra la API; esto
// cierra ese hueco.
//
//   · Listado con búsqueda, filtros, orden y paginación
//   · Alta de cuenta
//   · Edición: renombrar, correo, categoría, estado, contraseña
//   · Activar / desactivar de un clic
//   · Borrado, con confirmación escrita
//
// QUIÉN LA VE Y QUIÉN LA USA NO ES LO MISMO
// La ruta exige `Administradores`, que es lo que hace falta para LEER. Pero
// crear, editar y borrar exigen `Supervisor`. Un Administrador entra, lo ve
// todo y tiene los botones de escritura deshabilitados con el motivo puesto.
// Esto es COMODIDAD: quien mande un PATCH a mano se lleva un 403 igual. La
// vista nunca es la que decide.
//
// EL RECUENTO DE SUPERVISORES SE PIDE APARTE, Y NO ES UN CAPRICHO
// `contarSupervisoresActivos()` de usuariosApi cuenta sobre la lista CARGADA.
// Eso vale cuando caben todos en una página, pero en cuanto hay filtro o
// paginación miente: si estás en la página 2 y el único Supervisor está en la
// primera, cuenta cero y la vista bloquea acciones que sí eran legítimas.
// Aquí se lanza una consulta propia (`categoria=Supervisor&estado=Activo`,
// `limite=1`) y se lee su `total`, que es el número de verdad independiente
// de lo que se esté mirando. Cuesta una petición y quita una clase entera de
// avisos falsos.
// =========================================================================
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import {
  ArrowLeftIcon,
  RefreshCwIcon,
  SearchIcon,
  UserPlusIcon,
  PencilIcon,
  Trash2Icon,
  UserCheckIcon,
  UserXIcon,
  KeyRoundIcon,
  AlertCircleIcon,
  AlertTriangleIcon,
  CheckCircle2Icon,
  XIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  ArrowUpIcon,
  ArrowDownIcon,
  ShieldCheckIcon,
  EyeIcon,
  EyeOffIcon,
  Loader2Icon,
} from 'lucide-react';
import { useAppStore } from '../context/AppStore';
import { Rol } from '../services/authApi';
import {
  CambiosUsuario,
  EstadoCuenta,
  NuevoUsuario,
  Usuario,
  borrarUsuario,
  buscarUsuarios,
  crearUsuario,
  editarUsuario,
  mensajeError,
  puedeBorrar,
  puedeDesactivar,
} from '../services/usuariosApi';

// ===================================================================== //
// Constantes de presentación
// ===================================================================== //
const ROLES: Rol[] = ['Supervisor', 'Administradores', 'Usuarios', 'Invitado'];
const ESTADOS: EstadoCuenta[] = ['Activo', 'Inactivo'];
const POR_PAGINA = 25;

/**
 * Qué puede hacer cada categoría, en una frase.
 *
 * Va en el desplegable de alta y edición. Sin esto, elegir entre cuatro
 * palabras abstractas es adivinar: "Administradores" y "Supervisor" suenan
 * igual de importantes y nadie sabe cuál da más permisos.
 */
const QUE_PUEDE: Record<Rol, string> = {
  Supervisor: 'Todo, incluida la gestión de cuentas.',
  Administradores: 'Configura PLCs y bases; ve la actividad. No toca cuentas.',
  Usuarios: 'Opera y edita pantallas.',
  Invitado: 'Solo mira. No puede escribir nada.',
};

/** Color del distintivo de categoría. El Supervisor destaca a propósito. */
function tonoRol(r: string): string {
  if (r === 'Supervisor') {
    return 'bg-siemens/10 text-siemens-600 ring-siemens/30 dark:text-siemens-300';
  }
  if (r === 'Administradores') {
    return 'bg-state-warn/10 text-state-warn ring-state-warn/30';
  }
  if (r === 'Invitado') {
    return 'bg-slate-100 text-slate-400 ring-slate-200 dark:bg-navy-slate/40 dark:ring-navy-slate';
  }
  return 'bg-slate-100 text-slate-600 ring-slate-200 dark:bg-navy-slate/40 dark:text-slate-300 dark:ring-navy-slate';
}

/** Fecha larga y legible. Las vacías se marcan, no se dejan en blanco. */
function fecha(iso: string, vacio = '—'): string {
  if (!iso) return vacio;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return vacio;
  return d.toLocaleString(undefined, {
    day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

/** "hace 3 días". Para la columna de último acceso, que es la que se escanea. */
function haceCuanto(iso: string): string {
  if (!iso) return 'nunca';
  const d = new Date(iso).getTime();
  if (Number.isNaN(d)) return 'nunca';
  const s = Math.max(0, (Date.now() - d) / 1000);
  if (s < 60) return 'ahora mismo';
  if (s < 3600) return `hace ${Math.floor(s / 60)} min`;
  if (s < 86400) return `hace ${Math.floor(s / 3600)} h`;
  const dias = Math.floor(s / 86400);
  if (dias < 31) return `hace ${dias} d`;
  return `hace ${Math.floor(dias / 30)} meses`;
}

/**
 * Fuerza de la contraseña, en cuatro escalones.
 *
 * No bloquea nada: es información. Bloquear el alta por una regla de
 * complejidad empuja a la gente a "Password1!" y a apuntarlo en un papel, que
 * es peor que una contraseña larga y sencilla que se recuerda.
 */
function fuerza(p: string): { nivel: number; texto: string; clase: string } {
  if (!p) return { nivel: 0, texto: '', clase: '' };
  let n = 0;
  if (p.length >= 8) n++;
  if (p.length >= 12) n++;
  if (/[a-z]/.test(p) && /[A-Z]/.test(p)) n++;
  if (/\d/.test(p) && /[^\w\s]/.test(p)) n++;
  const escala = [
    { texto: 'Muy débil', clase: 'bg-state-error' },
    { texto: 'Débil', clase: 'bg-state-error' },
    { texto: 'Aceptable', clase: 'bg-state-warn' },
    { texto: 'Buena', clase: 'bg-siemens' },
    { texto: 'Fuerte', clase: 'bg-state-ok' },
  ];
  return { nivel: n, ...escala[n] };
}

// ===================================================================== //
// Piezas pequeñas
// ===================================================================== //
function Distintivo({ texto, clase }: { texto: string; clase: string }) {
  return (
    <span className={`inline-flex items-center rounded-md px-2 py-0.5 text-[11px] font-semibold ring-1 ring-inset ${clase}`}>
      {texto}
    </span>
  );
}

function Avatar({ nombre, activo }: { nombre: string; activo: boolean }) {
  return (
    <span
      className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-xs font-bold ring-1 ring-inset ${
        activo
          ? 'bg-siemens/10 text-siemens ring-siemens/25'
          : 'bg-slate-100 text-slate-400 ring-slate-200 dark:bg-navy-slate/40 dark:ring-navy-slate'
      }`}
    >
      {(nombre || '?').trim()[0]?.toUpperCase() ?? '?'}
    </span>
  );
}

/**
 * Botón de acción de fila.
 *
 * `motivo` no es un adorno: cuando la acción está vetada por una salvaguarda
 * (el último Supervisor, tu propia cuenta) el botón se deshabilita Y explica
 * por qué al pasar por encima. Un botón gris sin explicación se lee como un
 * fallo del programa.
 */
function AccionFila({
  titulo, motivo, onClick, children, peligro = false,
}: {
  titulo: string;
  motivo?: string;
  onClick: () => void;
  children: React.ReactNode;
  peligro?: boolean;
}) {
  const vetado = Boolean(motivo);
  return (
    <button
      onClick={onClick}
      disabled={vetado}
      title={motivo || titulo}
      aria-label={titulo}
      className={`flex h-8 w-8 items-center justify-center rounded-lg outline-none transition focus-visible:ring-2 focus-visible:ring-siemens/40 disabled:cursor-not-allowed disabled:opacity-30 ${
        peligro
          ? 'text-slate-400 hover:bg-state-error/10 hover:text-state-error'
          : 'text-slate-400 hover:bg-slate-100 hover:text-navy dark:hover:bg-navy-slate/40 dark:hover:text-slate-100'
      }`}
    >
      {children}
    </button>
  );
}

/** Cabecera de columna ordenable. */
function ColOrden({
  campo, actual, desc, onOrdenar, children, className = '',
}: {
  campo: string;
  actual: string;
  desc: boolean;
  onOrdenar: (c: string) => void;
  children: React.ReactNode;
  className?: string;
}) {
  const activo = actual === campo;
  return (
    <th className={`px-3 py-2 text-left font-semibold ${className}`}>
      <button
        onClick={() => onOrdenar(campo)}
        className={`inline-flex items-center gap-1 outline-none transition hover:text-navy focus-visible:ring-2 focus-visible:ring-siemens/40 dark:hover:text-slate-100 ${
          activo ? 'text-navy dark:text-slate-100' : ''
        }`}
      >
        {children}
        {activo &&
          (desc ? <ArrowDownIcon className="h-3 w-3" /> : <ArrowUpIcon className="h-3 w-3" />)}
      </button>
    </th>
  );
}

/** Lo que tarda en irse solo un aviso de éxito. */
const AUTO_CIERRE_MS = 5000;

/**
 * Aviso FLOTANTE, centrado arriba. Se va solo si es de éxito; los de error
 * esperan a que los cierres.
 *
 * POR QUÉ FLOTA Y NO VA EN LA PÁGINA
 * Antes se insertaba en el flujo, justo encima de los filtros. Aparecer
 * empujaba la tabla hacia abajo y desaparecer la subía de golpe, así que la
 * fila que estabas mirando se movía sola tres segundos después de tocar un
 * botón — y en una tabla de cuentas ahí es donde más caro sale pulsar en la
 * fila equivocada. Flotando, el contenido no se mueve nunca.
 *
 * TRES DECISIONES DEL DISEÑO
 *
 *  · Superficie SÓLIDA con sombra, no un tinte del color de estado. Encima de
 *    la tabla, un fondo translúcido deja ver las filas por debajo y el texto
 *    se vuelve ilegible.
 *  · El texto va en tinta NORMAL y el color de estado se queda en el icono.
 *    Un párrafo entero en verde o en rojo se lee peor, y el icono ya dice de
 *    qué tipo es sin gritar.
 *  · Barra de tiempo abajo. Un aviso que desaparece solo sin avisar deja la
 *    duda de si llegaste a leerlo; viéndola vaciarse, sabes cuánto queda —y
 *    que puedes cerrarlo tú si ya lo leíste.
 */
function Aviso({
  tipo, texto, onCerrar,
}: {
  tipo: 'ok' | 'error';
  texto: string;
  onCerrar: () => void;
}) {
  const ok = tipo === 'ok';
  return (
    <motion.div
      role="status"
      initial={{ opacity: 0, y: -14, scale: 0.97 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: -10, scale: 0.97 }}
      transition={{ duration: 0.18 }}
      className="pointer-events-auto relative w-[min(26rem,calc(100vw-2.5rem))] overflow-hidden rounded-xl border border-slate-200 bg-white shadow-lg dark:border-navy-slate dark:bg-navy-soft"
    >
      <div className="flex items-start gap-3 px-3.5 py-3">
        <span
          className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full ${
            ok ? 'bg-state-ok/15 text-state-ok' : 'bg-state-error/15 text-state-error'
          }`}
        >
          {ok
            ? <CheckCircle2Icon className="h-4 w-4" />
            : <AlertCircleIcon className="h-4 w-4" />}
        </span>
        <p className="flex-1 pt-1 text-xs leading-relaxed text-navy dark:text-slate-100">
          {texto}
        </p>
        <button
          onClick={onCerrar}
          aria-label="Cerrar aviso"
          className="-mr-1 mt-0.5 shrink-0 rounded p-1 text-slate-400 transition hover:bg-slate-100 hover:text-navy dark:hover:bg-navy-slate/50 dark:hover:text-slate-100"
        >
          <XIcon className="h-3.5 w-3.5" />
        </button>
      </div>

      {ok && (
        <motion.span
          aria-hidden="true"
          className="absolute inset-x-0 bottom-0 h-0.5 origin-left bg-state-ok/70"
          initial={{ scaleX: 1 }}
          animate={{ scaleX: 0 }}
          transition={{ duration: AUTO_CIERRE_MS / 1000, ease: 'linear' }}
        />
      )}
    </motion.div>
  );
}

// ===================================================================== //
// Campo de contraseña, con ojo y medidor
// ===================================================================== //
function CampoPassword({
  valor, onChange, etiqueta, ayuda, requerido,
}: {
  valor: string;
  onChange: (v: string) => void;
  etiqueta: string;
  ayuda?: string;
  requerido?: boolean;
}) {
  const [visible, setVisible] = useState(false);
  const f = fuerza(valor);
  return (
    <div>
      <label className="mb-1 block text-[11.5px] font-semibold text-slate-500 dark:text-slate-400">
        {etiqueta} {!requerido && <span className="font-normal text-slate-400">(opcional)</span>}
      </label>
      <div className="relative">
        <input
          type={visible ? 'text' : 'password'}
          value={valor}
          onChange={(e) => onChange(e.target.value)}
          autoComplete="new-password"
          className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 pr-10 text-sm outline-none transition focus:border-siemens focus:ring-2 focus:ring-siemens/20 dark:border-navy-slate dark:bg-navy dark:text-slate-100"
        />
        <button
          type="button"
          onClick={() => setVisible((v) => !v)}
          aria-label={visible ? 'Ocultar' : 'Mostrar'}
          className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-slate-400 transition hover:text-navy dark:hover:text-slate-200"
        >
          {visible ? <EyeOffIcon className="h-4 w-4" /> : <EyeIcon className="h-4 w-4" />}
        </button>
      </div>
      {valor && (
        <div className="mt-1.5 flex items-center gap-2">
          <div className="flex h-1 flex-1 gap-0.5">
            {[0, 1, 2, 3].map((i) => (
              <div
                key={i}
                className={`h-full flex-1 rounded-full transition ${
                  i < f.nivel ? f.clase : 'bg-slate-200 dark:bg-navy-slate'
                }`}
              />
            ))}
          </div>
          <span className="text-[10.5px] font-medium text-slate-400">{f.texto}</span>
        </div>
      )}
      {ayuda && <p className="mt-1 text-[11px] leading-relaxed text-slate-400">{ayuda}</p>}
    </div>
  );
}

// ===================================================================== //
// Panel de alta / edición
// ===================================================================== //
/**
 * El mismo panel sirve para crear y para editar. La diferencia real es cuál
 * es el estado de partida: al crear, todo vacío y la contraseña obligatoria;
 * al editar, los valores actuales y la contraseña opcional (vacía = no la
 * toques). Separarlos en dos componentes duplicaría la validación entera
 * para cambiar dos etiquetas.
 */
function PanelCuenta({
  original, onCerrar, onGuardado, onError,
}: {
  original: Usuario | null;   // null = alta
  onCerrar: () => void;
  onGuardado: (msg: string) => void;
  onError: (msg: string) => void;
}) {
  const editando = original !== null;
  const [usuario, setUsuario] = useState(original?.usuario ?? '');
  const [email, setEmail] = useState(original?.email ?? '');
  const [categoria, setCategoria] = useState<Rol>(original?.categoria ?? 'Usuarios');
  const [estado, setEstado] = useState<EstadoCuenta>(original?.estado ?? 'Activo');
  const [password, setPassword] = useState('');
  const [guardando, setGuardando] = useState(false);
  const primerCampo = useRef<HTMLInputElement>(null);

  useEffect(() => { primerCampo.current?.focus(); }, []);

  // Cerrar con Escape: en un panel modal se espera, y sin ello hay que ir a
  // buscar la X con el ratón.
  useEffect(() => {
    const alPulsar = (e: KeyboardEvent) => { if (e.key === 'Escape') onCerrar(); };
    window.addEventListener('keydown', alPulsar);
    return () => window.removeEventListener('keydown', alPulsar);
  }, [onCerrar]);

  const nombreValido = /^[A-Za-z0-9_.-]{3,50}$/.test(usuario.trim());
  const puedeGuardar =
    nombreValido && !guardando && (editando ? true : password.length >= 4);

  /**
   * Al editar se manda SOLO lo que cambió.
   *
   * Mandar el objeto entero funcionaría, pero la respuesta del backend trae la
   * lista de cambios aplicados y se la enseñamos al usuario. Si se manda todo,
   * esa lista dice "categoría: Usuarios -> Usuarios" y deja de servir para
   * nada. Además evita pisar sin querer un cambio que hizo otro mientras este
   * panel estaba abierto.
   */
  async function guardar() {
    setGuardando(true);
    try {
      if (!editando) {
        const nuevo: NuevoUsuario = {
          usuario: usuario.trim(),
          password,
          email: email.trim(),
          categoria,
          estado,
        };
        const creado = await crearUsuario(nuevo);
        onGuardado(`Cuenta ${creado.usuario} creada como ${creado.categoria}.`);
      } else {
        const cambios: CambiosUsuario = {};
        if (usuario.trim() !== original!.usuario) cambios.nuevo_usuario = usuario.trim();
        if (email.trim() !== (original!.email ?? '')) cambios.email = email.trim();
        if (categoria !== original!.categoria) cambios.categoria = categoria;
        if (estado !== original!.estado) cambios.estado = estado;
        if (password) cambios.password = password;

        if (Object.keys(cambios).length === 0) {
          onCerrar();
          return;
        }
        const r = await editarUsuario(original!.usuario, cambios);
        const lista = (r.cambios ?? []).join(', ');
        onGuardado(lista ? `${r.usuario}: ${lista}.` : r.mensaje);
      }
      onCerrar();
    } catch (e) {
      onError(mensajeError(e));
    } finally {
      setGuardando(false);
    }
  }

  const etiqueta = 'mb-1 block text-[11.5px] font-semibold text-slate-500 dark:text-slate-400';
  const campo =
    'w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm outline-none transition focus:border-siemens focus:ring-2 focus:ring-siemens/20 dark:border-navy-slate dark:bg-navy dark:text-slate-100';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <motion.div
        initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
        onClick={onCerrar}
        className="absolute inset-0 bg-navy/50 backdrop-blur-sm"
      />
      <motion.div
        initial={{ opacity: 0, y: 12, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: 12, scale: 0.98 }}
        role="dialog"
        aria-modal="true"
        className="relative z-10 w-full max-w-md overflow-hidden rounded-xl border border-slate-200 bg-white shadow-2xl dark:border-navy-slate dark:bg-navy-soft"
      >
        <header className="flex items-center justify-between border-b border-slate-200 px-5 py-3.5 dark:border-navy-slate">
          <div>
            <p className="text-sm font-bold text-navy dark:text-slate-100">
              {editando ? `Editar «${original!.usuario}»` : 'Nueva cuenta'}
            </p>
            <p className="text-[11.5px] text-slate-400">
              {editando
                ? 'Lo que dejes igual no se toca.'
                : 'La contraseña solo se manda ahora; después no se puede leer.'}
            </p>
          </div>
          <button onClick={onCerrar} aria-label="Cerrar"
            className="rounded-lg p-1.5 text-slate-400 transition hover:bg-slate-100 hover:text-navy dark:hover:bg-navy-slate/40">
            <XIcon className="h-4 w-4" />
          </button>
        </header>

        <div className="mp-scroll mp-scroll-dark max-h-[65vh] space-y-3.5 overflow-y-auto px-5 py-4">
          <div>
            <label className={etiqueta}>Nombre de usuario</label>
            <input
              ref={primerCampo}
              value={usuario}
              onChange={(e) => setUsuario(e.target.value)}
              autoComplete="off"
              className={campo}
            />
            {usuario && !nombreValido && (
              <p className="mt-1 text-[11px] text-state-error">
                Entre 3 y 50 caracteres: letras, números, punto, guion y guion bajo.
              </p>
            )}
            {editando && usuario.trim() !== original!.usuario && nombreValido && (
              <p className="mt-1 flex items-start gap-1 text-[11px] leading-relaxed text-state-warn">
                <AlertTriangleIcon className="mt-px h-3 w-3 shrink-0" />
                Se renombra la cuenta. Tendrá que entrar con el nombre nuevo.
              </p>
            )}
          </div>

          <div>
            <label className={etiqueta}>
              Correo <span className="font-normal text-slate-400">(opcional)</span>
            </label>
            <input
              type="email" value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="off" className={campo}
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={etiqueta}>Categoría</label>
              <select
                value={categoria}
                onChange={(e) => setCategoria(e.target.value as Rol)}
                className={campo}
              >
                {ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
              </select>
            </div>
            <div>
              <label className={etiqueta}>Estado</label>
              <select
                value={estado}
                onChange={(e) => setEstado(e.target.value as EstadoCuenta)}
                className={campo}
              >
                {ESTADOS.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
            </div>
          </div>
          <p className="rounded-lg bg-slate-50 px-3 py-2 text-[11px] leading-relaxed text-slate-500 dark:bg-navy/60 dark:text-slate-400">
            <strong className="font-semibold">{categoria}:</strong> {QUE_PUEDE[categoria]}
          </p>

          <CampoPassword
            valor={password}
            onChange={setPassword}
            requerido={!editando}
            etiqueta={editando ? 'Contraseña nueva' : 'Contraseña'}
            ayuda={
              editando
                ? 'Déjala vacía para no cambiarla. Si la cambias, se cierran sus sesiones abiertas.'
                : undefined
            }
          />
        </div>

        <footer className="flex items-center justify-end gap-2 border-t border-slate-200 px-5 py-3 dark:border-navy-slate">
          <button
            onClick={onCerrar}
            className="rounded-lg px-3 py-2 text-xs font-semibold text-slate-500 transition hover:bg-slate-100 dark:hover:bg-navy-slate/40"
          >
            Cancelar
          </button>
          <button
            onClick={guardar}
            disabled={!puedeGuardar}
            className="flex items-center gap-1.5 rounded-lg bg-siemens px-4 py-2 text-xs font-semibold text-white transition hover:bg-siemens-600 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {guardando && <Loader2Icon className="h-3.5 w-3.5 animate-spin" />}
            {editando ? 'Guardar cambios' : 'Crear cuenta'}
          </button>
        </footer>
      </motion.div>
    </div>
  );
}

// ===================================================================== //
// Confirmación de borrado
// ===================================================================== //
/**
 * Obliga a ESCRIBIR el nombre de la cuenta.
 *
 * Un "¿Seguro?" con dos botones se despacha con un doble clic mecánico. Aquí
 * se borra una cuenta y con ella se pierde de quién eran las acciones que
 * firmó; que cueste diez segundos más es justamente el objetivo.
 */
function ConfirmarBorrado({
  cuenta, onCerrar, onBorrado, onError,
}: {
  cuenta: Usuario;
  onCerrar: () => void;
  onBorrado: (msg: string) => void;
  onError: (msg: string) => void;
}) {
  const [texto, setTexto] = useState('');
  const [borrando, setBorrando] = useState(false);
  const coincide = texto.trim() === cuenta.usuario;

  useEffect(() => {
    const alPulsar = (e: KeyboardEvent) => { if (e.key === 'Escape') onCerrar(); };
    window.addEventListener('keydown', alPulsar);
    return () => window.removeEventListener('keydown', alPulsar);
  }, [onCerrar]);

  async function confirmar() {
    setBorrando(true);
    try {
      await borrarUsuario(cuenta.usuario);
      onBorrado(`Cuenta ${cuenta.usuario} borrada.`);
      onCerrar();
    } catch (e) {
      onError(mensajeError(e));
      setBorrando(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <motion.div
        initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
        onClick={onCerrar}
        className="absolute inset-0 bg-navy/50 backdrop-blur-sm"
      />
      <motion.div
        initial={{ opacity: 0, y: 12, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: 12, scale: 0.98 }}
        role="dialog" aria-modal="true"
        className="relative z-10 w-full max-w-sm overflow-hidden rounded-xl border border-slate-200 bg-white shadow-2xl dark:border-navy-slate dark:bg-navy-soft"
      >
        <div className="px-5 py-4">
          <div className="mb-3 flex items-center gap-2.5">
            <span className="flex h-9 w-9 items-center justify-center rounded-full bg-state-error/10 text-state-error">
              <Trash2Icon className="h-4 w-4" />
            </span>
            <p className="text-sm font-bold text-navy dark:text-slate-100">Borrar cuenta</p>
          </div>
          <p className="mb-3 text-xs leading-relaxed text-slate-500 dark:text-slate-400">
            Se borra <strong className="text-navy dark:text-slate-200">{cuenta.usuario}</strong> y
            se cierran sus sesiones. Lo que ya hizo sigue en la auditoría, pero
            aparecerá con el identificador y sin nombre.
          </p>
          <p className="mb-1.5 text-[11.5px] text-slate-500 dark:text-slate-400">
            Escribe <code className="rounded bg-slate-100 px-1 py-0.5 font-mono text-[11px] text-navy dark:bg-navy dark:text-slate-200">{cuenta.usuario}</code> para confirmar:
          </p>
          <input
            value={texto}
            onChange={(e) => setTexto(e.target.value)}
            autoFocus autoComplete="off"
            className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm outline-none transition focus:border-state-error focus:ring-2 focus:ring-state-error/20 dark:border-navy-slate dark:bg-navy dark:text-slate-100"
          />
        </div>
        <footer className="flex items-center justify-end gap-2 border-t border-slate-200 px-5 py-3 dark:border-navy-slate">
          <button onClick={onCerrar}
            className="rounded-lg px-3 py-2 text-xs font-semibold text-slate-500 transition hover:bg-slate-100 dark:hover:bg-navy-slate/40">
            Cancelar
          </button>
          <button
            onClick={confirmar}
            disabled={!coincide || borrando}
            className="flex items-center gap-1.5 rounded-lg bg-state-error px-4 py-2 text-xs font-semibold text-white transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {borrando && <Loader2Icon className="h-3.5 w-3.5 animate-spin" />}
            Borrar definitivamente
          </button>
        </footer>
      </motion.div>
    </div>
  );
}

// ===================================================================== //
// Pantalla
// ===================================================================== //
export function Usuarios() {
  const navigate = useNavigate();
  const { sesion } = useAppStore();
  const yo = sesion?.usuario ?? '';
  const soySupervisor = sesion?.categoria === 'Supervisor';

  const [lista, setLista] = useState<Usuario[]>([]);
  const [total, setTotal] = useState(0);
  const [supervisores, setSupervisores] = useState(1);
  const [cargando, setCargando] = useState(true);

  const [texto, setTexto] = useState('');
  const [textoAplicado, setTextoAplicado] = useState('');
  const [fRol, setFRol] = useState<Rol | ''>('');
  const [fEstado, setFEstado] = useState<EstadoCuenta | ''>('');
  const [orden, setOrden] = useState('usuario');
  const [desc, setDesc] = useState(false);
  const [pagina, setPagina] = useState(0);

  const [panel, setPanel] = useState<{ abierto: boolean; cuenta: Usuario | null }>({
    abierto: false, cuenta: null,
  });
  const [borrar, setBorrar] = useState<Usuario | null>(null);
  const [aviso, setAviso] = useState<{ tipo: 'ok' | 'error'; texto: string } | null>(null);

  // El buscador espera 300 ms. Sin esto sale una petición por tecla y las
  // respuestas pueden llegar desordenadas, mostrando resultados de una
  // búsqueda anterior.
  useEffect(() => {
    const t = setTimeout(() => { setTextoAplicado(texto); setPagina(0); }, 300);
    return () => clearTimeout(t);
  }, [texto]);

  const cargar = useCallback(async () => {
    setCargando(true);
    try {
      // Las dos consultas van en paralelo: la segunda es la que da el número
      // real de Supervisores activos (ver la cabecera del fichero).
      const [pag, sup] = await Promise.all([
        buscarUsuarios({
          texto: textoAplicado, categoria: fRol, estado: fEstado,
          orden, descendente: desc,
          limite: POR_PAGINA, desplazamiento: pagina * POR_PAGINA,
        }),
        buscarUsuarios({ categoria: 'Supervisor', estado: 'Activo', limite: 1 }),
      ]);
      setLista(pag.usuarios);
      setTotal(pag.total);
      setSupervisores(sup.total);
    } catch (e) {
      setAviso({ tipo: 'error', texto: mensajeError(e) });
    } finally {
      setCargando(false);
    }
  }, [textoAplicado, fRol, fEstado, orden, desc, pagina]);

  useEffect(() => { void cargar(); }, [cargar]);

  // Los avisos de éxito se van solos; los de error se quedan hasta que los
  // cierres, porque suelen necesitar que hagas algo.
  useEffect(() => {
    if (aviso?.tipo !== 'ok') return;
    const t = setTimeout(() => setAviso(null), AUTO_CIERRE_MS);
    return () => clearTimeout(t);
  }, [aviso]);

  function ordenarPor(campo: string) {
    if (orden === campo) { setDesc((d) => !d); return; }
    setOrden(campo);
    setDesc(false);
  }

  async function alternarEstado(u: Usuario) {
    try {
      await editarUsuario(u.usuario, {
        estado: u.estado === 'Activo' ? 'Inactivo' : 'Activo',
      });
      setAviso({
        tipo: 'ok',
        texto: `${u.usuario} ${u.estado === 'Activo' ? 'desactivado' : 'activado'}.`,
      });
      void cargar();
    } catch (e) {
      setAviso({ tipo: 'error', texto: mensajeError(e) });
    }
  }

  const desdeUno = total === 0 ? 0 : pagina * POR_PAGINA + 1;
  const hasta = Math.min(total, (pagina + 1) * POR_PAGINA);
  const hayFiltro = Boolean(textoAplicado || fRol || fEstado);

  /** Por qué NO se puede escribir. Vacío = sí se puede. */
  const vetoEscritura = soySupervisor
    ? ''
    : 'Solo un Supervisor puede modificar cuentas.';

  const campoFiltro =
    'rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs outline-none transition focus:border-siemens focus:ring-2 focus:ring-siemens/20 dark:border-navy-slate dark:bg-navy-soft dark:text-slate-100';

  return (
    <div className="flex h-full w-full flex-col bg-slate-50 dark:bg-navy">
      {/* ---------------------------------------------------- cabecera --- */}
      <header className="flex shrink-0 items-center justify-between gap-4 border-b border-slate-200 bg-white px-5 py-3 dark:border-navy-slate dark:bg-navy-soft">
        <div className="flex min-w-0 items-center gap-3">
          <button
            onClick={() => navigate('/menu')}
            aria-label="Volver al menú"
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-slate-500 outline-none transition hover:bg-slate-100 hover:text-navy focus-visible:ring-2 focus-visible:ring-siemens/40 dark:hover:bg-navy-slate/40 dark:hover:text-slate-100"
          >
            <ArrowLeftIcon className="h-5 w-5" />
          </button>
          <div className="min-w-0">
            <p className="truncate text-[15px] font-bold text-navy dark:text-slate-100">
              Cuentas
            </p>
            <p className="truncate text-[11.5px] text-slate-400">
              Quién puede entrar y qué puede hacer
            </p>
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          <button
            onClick={() => void cargar()}
            disabled={cargando}
            className="flex min-h-[34px] items-center gap-1.5 rounded-lg border border-slate-200 px-3 text-xs font-semibold text-slate-600 outline-none transition hover:bg-slate-100 focus-visible:ring-2 focus-visible:ring-siemens/40 disabled:opacity-50 dark:border-navy-slate dark:text-slate-300 dark:hover:bg-navy-slate/40"
          >
            <RefreshCwIcon className={`h-3.5 w-3.5 ${cargando ? 'animate-spin' : ''}`} />
            Actualizar
          </button>
          <button
            onClick={() => setPanel({ abierto: true, cuenta: null })}
            disabled={Boolean(vetoEscritura)}
            title={vetoEscritura || 'Crear una cuenta'}
            className="flex min-h-[34px] items-center gap-1.5 rounded-lg bg-siemens px-3.5 text-xs font-semibold text-white outline-none transition hover:bg-siemens-600 focus-visible:ring-2 focus-visible:ring-siemens/40 disabled:cursor-not-allowed disabled:opacity-40"
          >
            <UserPlusIcon className="h-3.5 w-3.5" />
            Nueva cuenta
          </button>
        </div>
      </header>

      <div className="mp-scroll mp-scroll-dark flex-1 overflow-y-auto p-5">
        {/* Un Administrador ve todo pero no escribe: mejor decírselo una vez
            arriba que dejar ocho botones grises sin explicación. */}
        {vetoEscritura && (
          <div className="mb-4 flex items-start gap-2.5 rounded-lg border border-slate-200 bg-white px-3.5 py-2.5 text-xs text-slate-500 dark:border-navy-slate dark:bg-navy-soft dark:text-slate-400">
            <ShieldCheckIcon className="mt-px h-4 w-4 shrink-0 text-slate-400" />
            <p className="leading-relaxed">
              Estás en modo consulta. {vetoEscritura}
            </p>
          </div>
        )}

        {/* ------------------------------------------------------ filtros - */}
        <div className="mb-3 flex flex-wrap items-center gap-2">
          {/* Ancho acotado: `flex-1` lo estiraba hasta el borde de la
              pantalla y empujaba los dos desplegables al otro extremo, con un
              vacío enorme en medio. Un buscador de nombres no necesita 1.500
              píxeles. */}
          <div className="relative w-full sm:w-72">
            <SearchIcon className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
            <input
              value={texto}
              onChange={(e) => setTexto(e.target.value)}
              placeholder="Buscar por nombre o correo…"
              className="w-full rounded-lg border border-slate-200 bg-white py-1.5 pl-8 pr-3 text-xs outline-none transition focus:border-siemens focus:ring-2 focus:ring-siemens/20 dark:border-navy-slate dark:bg-navy-soft dark:text-slate-100"
            />
          </div>
          <select value={fRol}
            onChange={(e) => { setFRol(e.target.value as Rol | ''); setPagina(0); }}
            className={campoFiltro}>
            <option value="">Todas las categorías</option>
            {ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
          </select>
          <select value={fEstado}
            onChange={(e) => { setFEstado(e.target.value as EstadoCuenta | ''); setPagina(0); }}
            className={campoFiltro}>
            <option value="">Todos los estados</option>
            {ESTADOS.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </div>

        {/* -------------------------------------------------------- tabla - */}
        <div className="overflow-hidden rounded-xl border border-slate-200 bg-white dark:border-navy-slate dark:bg-navy-soft">
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="border-b border-slate-200 bg-slate-50 text-[11px] uppercase tracking-wide text-slate-400 dark:border-navy-slate dark:bg-navy/40">
                <tr>
                  <ColOrden campo="usuario" actual={orden} desc={desc} onOrdenar={ordenarPor}>
                    Usuario
                  </ColOrden>
                  <ColOrden campo="categoria" actual={orden} desc={desc} onOrdenar={ordenarPor}>
                    Categoría
                  </ColOrden>
                  <ColOrden campo="estado" actual={orden} desc={desc} onOrdenar={ordenarPor}>
                    Estado
                  </ColOrden>
                  <ColOrden campo="ultimo_acceso" actual={orden} desc={desc}
                    onOrdenar={ordenarPor} className="hidden md:table-cell">
                    Último acceso
                  </ColOrden>
                  <ColOrden campo="creado_en" actual={orden} desc={desc}
                    onOrdenar={ordenarPor} className="hidden lg:table-cell">
                    Creada
                  </ColOrden>
                  <th className="px-3 py-2 text-right font-semibold">Acciones</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-navy-slate/60">
                {cargando && lista.length === 0 && (
                  <tr>
                    <td colSpan={6} className="px-3 py-10 text-center text-slate-400">
                      <Loader2Icon className="mx-auto mb-2 h-5 w-5 animate-spin" />
                      Cargando cuentas…
                    </td>
                  </tr>
                )}

                {!cargando && lista.length === 0 && (
                  <tr>
                    <td colSpan={6} className="px-3 py-10 text-center">
                      <p className="text-sm font-semibold text-slate-500 dark:text-slate-400">
                        {hayFiltro ? 'Ninguna cuenta coincide' : 'Todavía no hay cuentas'}
                      </p>
                      <p className="mt-1 text-[11.5px] text-slate-400">
                        {hayFiltro
                          ? 'Prueba a quitar algún filtro.'
                          : 'Crea la primera con «Nueva cuenta».'}
                      </p>
                    </td>
                  </tr>
                )}

                {lista.map((u) => {
                  const activo = u.estado === 'Activo';
                  const esYo = u.usuario === yo;
                  const vBorrar = vetoEscritura || puedeBorrar(u, yo, supervisores).motivo;
                  const vEstado = activo
                    ? vetoEscritura || puedeDesactivar(u, yo, supervisores).motivo
                    : vetoEscritura;

                  return (
                    <tr key={u.id}
                      className="transition hover:bg-slate-50/70 dark:hover:bg-navy/40">
                      <td className="px-3 py-2.5">
                        <div className="flex items-center gap-2.5">
                          <Avatar nombre={u.usuario} activo={activo} />
                          <div className="min-w-0">
                            <p className="flex items-center gap-1.5 truncate font-semibold text-navy dark:text-slate-100">
                              {u.usuario}
                              {esYo && (
                                <span className="rounded bg-siemens/10 px-1 py-px text-[9.5px] font-bold uppercase tracking-wide text-siemens">
                                  tú
                                </span>
                              )}
                            </p>
                            <p className="truncate text-[11px] text-slate-400">
                              {u.email || 'sin correo'}
                            </p>
                          </div>
                        </div>
                      </td>
                      <td className="px-3 py-2.5">
                        <Distintivo texto={u.categoria} clase={tonoRol(u.categoria)} />
                      </td>
                      <td className="px-3 py-2.5">
                        <Distintivo
                          texto={u.estado}
                          clase={activo
                            ? 'bg-state-ok/10 text-state-ok ring-state-ok/30'
                            : 'bg-slate-100 text-slate-400 ring-slate-200 dark:bg-navy-slate/40 dark:ring-navy-slate'}
                        />
                      </td>
                      <td className="hidden px-3 py-2.5 md:table-cell">
                        <p className="text-slate-600 dark:text-slate-300">
                          {haceCuanto(u.ultimo_acceso)}
                        </p>
                        <p className="text-[10.5px] text-slate-400">{fecha(u.ultimo_acceso, '')}</p>
                      </td>
                      <td className="hidden px-3 py-2.5 text-slate-500 dark:text-slate-400 lg:table-cell">
                        {fecha(u.creado_en)}
                      </td>
                      <td className="px-3 py-2.5">
                        <div className="flex items-center justify-end gap-0.5">
                          <AccionFila
                            titulo="Editar"
                            motivo={vetoEscritura}
                            onClick={() => setPanel({ abierto: true, cuenta: u })}
                          >
                            <PencilIcon className="h-3.5 w-3.5" />
                          </AccionFila>
                          <AccionFila
                            titulo="Cambiar la contraseña"
                            motivo={vetoEscritura}
                            onClick={() => setPanel({ abierto: true, cuenta: u })}
                          >
                            <KeyRoundIcon className="h-3.5 w-3.5" />
                          </AccionFila>
                          <AccionFila
                            titulo={activo ? 'Desactivar' : 'Activar'}
                            motivo={vEstado}
                            onClick={() => void alternarEstado(u)}
                          >
                            {activo
                              ? <UserXIcon className="h-3.5 w-3.5" />
                              : <UserCheckIcon className="h-3.5 w-3.5" />}
                          </AccionFila>
                          <AccionFila
                            titulo="Borrar" peligro
                            motivo={vBorrar}
                            onClick={() => setBorrar(u)}
                          >
                            <Trash2Icon className="h-3.5 w-3.5" />
                          </AccionFila>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* --------------------------------------------------- paginado - */}
          {total > 0 && (
            <div className="flex items-center justify-between border-t border-slate-200 px-3 py-2 dark:border-navy-slate">
              <p className="text-[11.5px] text-slate-400">
                {desdeUno}–{hasta} de {total}
                {supervisores <= 1 && (
                  <span className="ml-2 text-state-warn">
                    · solo queda 1 Supervisor activo
                  </span>
                )}
              </p>
              <div className="flex items-center gap-1">
                <button
                  onClick={() => setPagina((p) => Math.max(0, p - 1))}
                  disabled={pagina === 0}
                  aria-label="Página anterior"
                  className="rounded-lg p-1.5 text-slate-400 transition hover:bg-slate-100 hover:text-navy disabled:opacity-30 dark:hover:bg-navy-slate/40"
                >
                  <ChevronLeftIcon className="h-4 w-4" />
                </button>
                <button
                  onClick={() => setPagina((p) => p + 1)}
                  disabled={hasta >= total}
                  aria-label="Página siguiente"
                  className="rounded-lg p-1.5 text-slate-400 transition hover:bg-slate-100 hover:text-navy disabled:opacity-30 dark:hover:bg-navy-slate/40"
                >
                  <ChevronRightIcon className="h-4 w-4" />
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      <AnimatePresence>
        {panel.abierto && (
          <PanelCuenta
            key={panel.cuenta?.id ?? 'nueva'}
            original={panel.cuenta}
            onCerrar={() => setPanel({ abierto: false, cuenta: null })}
            onGuardado={(m) => { setAviso({ tipo: 'ok', texto: m }); void cargar(); }}
            onError={(m) => setAviso({ tipo: 'error', texto: m })}
          />
        )}
        {borrar && (
          <ConfirmarBorrado
            key={`borrar-${borrar.id}`}
            cuenta={borrar}
            onCerrar={() => setBorrar(null)}
            onBorrado={(m) => { setAviso({ tipo: 'ok', texto: m }); void cargar(); }}
            onError={(m) => setAviso({ tipo: 'error', texto: m })}
          />
        )}
      </AnimatePresence>

      {/* ------------------------------------------------- avisos flotantes -
          `fixed` para que no empuje nada, y `pointer-events-none` en la CAPA
          para no robarle los clics a la tabla que queda debajo: solo el toast
          en sí los recibe (`pointer-events-auto`). Centrado arriba, a la
          altura de la fila de filtros: es donde ya está mirando quien acaba de
          pulsar algo, y no tapa ni la cabecera ni los botones de cada fila. */}
      <div className="pointer-events-none fixed inset-x-0 top-16 z-50 flex justify-center px-4">
        <AnimatePresence>
          {aviso && (
            <Aviso key={aviso.texto} tipo={aviso.tipo} texto={aviso.texto}
              onCerrar={() => setAviso(null)} />
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}
