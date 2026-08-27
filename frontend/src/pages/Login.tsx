// =========================================================================
// Login.tsx  —  Pantalla de acceso de Psi Core
//
// CONECTADA al backend: `enviar()` llama a `/auth/registro` y `/auth/login`
// (vía `services/authApi.ts`), guarda el token de sesión y navega a /menu.
//
// Antes de pintar el formulario se consulta `GET /auth/estado` (público) para
// no pedirle datos a nadie que no vayan a servir de nada. Ese endpoint decide
// cuál de estos cuatro estados se muestra:
//
//   * backend caído       -> no se puede saber nada: se dice y no se pide nada
//   * sin base de datos    -> las cuentas no tienen dónde vivir: se explica
//   * sin ninguna cuenta   -> modo arranque: se abre en CREAR CUENTA y la
//                             categoría queda fija en Supervisor (la fuerza el
//                             backend de todas formas; ocultarlo sería dejar
//                             que el usuario elija algo que no se respetará)
//   * ya hay cuentas       -> solo ENTRAR: del segundo usuario en adelante,
//                             `/auth/registro` exige rol Supervisor
//
// Dos pestañas sobre el mismo panel:
//
//   * ENTRAR       -> usuario + contraseña. Lo mínimo para autenticar.
//   * CREAR CUENTA -> los campos que el usuario SÍ escribe de la tabla
//                     `dbo.usuarios`: usuario, contraseña, email, categoría
//                     y estado.
//
// Columnas de `dbo.usuarios` que NO son campos de formulario, y por qué:
//
//   id            IDENTITY, lo pone el motor.
//   password_hash nunca viaja en claro: se escribe la contraseña y el backend
//                 guarda el hash. Por eso el campo se llama "Contraseña".
//   algoritmo     lo decide el servidor (bcrypt/argon2), no el usuario. Se
//                 muestra como dato informativo, deshabilitado.
//   creado_en     DEFAULT del motor.
//   ultimo_acceso lo escribe el backend en cada login correcto.
//
// El layout es split: panel de marca a la izquierda (donde va el logo) y
// formulario a la derecha. Por debajo de `lg` el panel colapsa a una cabecera
// compacta para no comerse la pantalla en móvil.
// =========================================================================
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion, useReducedMotion } from 'framer-motion';
import {
  UserIcon,
  LockIcon,
  MailIcon,
  EyeIcon,
  EyeOffIcon,
  ShieldCheckIcon,
  LogInIcon,
  UserPlusIcon,
  Loader2Icon,
  AlertCircleIcon,
  InfoIcon,
  ActivityIcon,
  DatabaseIcon,
  CpuIcon,
  KeyRoundIcon,
  ChevronDownIcon,
  ArrowRightIcon,
} from 'lucide-react';
import { useAppStore } from '../context/AppStore';
import { AsistenteArranque } from '../components/auth/AsistenteArranque';
import {
  fetchEstadoAuth,
  getBasePreferida,
  setBasePreferida,
  login,
  registro,
  type BaseDatos,
  type EstadoAuth,
  type InfoBd,
} from '../services/authApi';

// ─── Marca ───────────────────────────────────────────────────────
//
// Para poner el logo: deja el archivo en `frontend/public/logo.png`. Si
// prefieres otra extensión, cámbiala acá y ya.
//
// El logo es un WORDMARK horizontal (~3.3:1), no un icono cuadrado. Por eso
// se escala por ALTURA (`h-… w-auto`) y no dentro de una caja cuadrada: si se
// mete en un cuadrado, `object-contain` lo encoge al ancho de la caja y queda
// una estampilla diminuta con aire arriba y abajo.
//
// Como la imagen trae fondo blanco y letras azul marino, sobre el panel
// oscuro se apoya en una "placa" blanca. No es un parche: es lo que hay que
// hacer con un logo de fondo sólido sobre una superficie oscura.
//
// `public/logo.png` (900×170) es el `logo.jpeg` original recortado: el JPEG
// traía el blanco METIDO DENTRO — la tinta ocupaba apenas el 52% del alto, y
// el margen inferior (183px) era casi cuatro veces el superior (50px). Eso
// hacía dos cosas: la placa salía altísima con las letras chiquitas, y el
// logo quedaba visualmente descentrado hacia arriba.
//
// Ahora el archivo va justo a la tinta y el aire lo pone el padding de la
// placa, que sí se puede ajustar desde acá.
const LOGO_SRC = '/logo.png';
const APP_NAME = 'Psi Core';

// ─── ⚠️ ATAJO DE DESARROLLO ──────────────────────────────────────
//
// En `true`, el botón entra DIRECTO a /menu: sin validar campos, sin esperar
// y sin mirar lo que haya escrito. Sirve para no rellenar el formulario cada
// vez que se recarga mientras se trabaja en las otras pantallas.
//
// Ponlo en `false` para probar el formulario de verdad (campos obligatorios,
// mínimos, correo, contraseñas que coinciden). Y déjalo en `false` el día que
// esto se conecte al backend — con `true` cualquiera entra escribiendo nada.
//
// El aviso del pie de la pantalla cambia solo según este valor, así que
// siempre se ve desde la interfaz en qué modo está.
const ATAJO_DEV = false;

// Categorías de `usuarios.categoria`. El orden es de más a menos permisos.
// Estos strings se guardan tal cual en la columna (varchar(40)): si cambian
// acá, hay que migrar las filas existentes.
const CATEGORIAS = ['Supervisor', 'Administradores', 'Usuarios', 'Invitado'];

// Valores de `usuarios.estado`.
const ESTADOS = ['Activo', 'Inactivo'];

type Pestana = 'entrar' | 'registro';
type Errores = Record<string, string>;

export function Login() {
  const navigate = useNavigate();
  const { t, refrescarSesion } = useAppStore();
  const sinMovimiento = useReducedMotion();

  const [pestana, setPestana] = useState<Pestana>('entrar');
  const [enviando, setEnviando] = useState(false);
  const [errores, setErrores] = useState<Errores>({});

  // ── Estado del sistema de cuentas ─────────────────────────────
  //
  // `null` mientras se consulta. La pantalla NO pinta el formulario hasta
  // saberlo: rellenar usuario y contraseña para descubrir al pulsar el botón
  // que no hay base de datos es exactamente el tipo de trabajo tirado que
  // este endpoint existe para evitar.
  const [estado, setEstado] = useState<EstadoAuth | null>(null);
  const [errorEstado, setErrorEstado] = useState('');
  const [mostrarOlvido, setMostrarOlvido] = useState(false);

  // ── Base de datos elegida ─────────────────────────────────────
  //
  // Cada base tiene su PROPIA tabla `usuarios`: una cuenta creada en la local
  // no existe en la del servidor. Por eso la elección va aquí, antes de pedir
  // credenciales, y no escondida en la configuración.
  const [bases, setBases] = useState<BaseDatos[]>([]);
  const [dbId, setDbId] = useState('');
  // Se incrementa para volver a consultar el estado sin recargar la página:
  // lo usa el asistente cuando acaba de dar de alta la conexión.
  const [recarga, setRecarga] = useState(0);
  const [selectorAbierto, setSelectorAbierto] = useState(false);

  // Revisar TODAS las bases contra el servidor cuesta una conexión por base,
  // y con un servidor remoto apagado eso son segundos de pantalla en blanco.
  // Se paga en los dos momentos en los que hace falta —al abrir el login y
  // tras configurar una conexión— y no cada vez que se despliega el selector:
  // al cambiar de base, el backend ya diagnostica ESA sola si falla.
  const ultimaRevision = useRef(-1);

  // Se vuelve a preguntar en CADA cambio de base: `hay_usuarios` y
  // `bd_disponible` son propiedades de la base, no del sistema. Sin esto, al
  // cambiar de opción el login seguiría diciendo "crea la primera cuenta"
  // sobre una base que ya tiene diez.
  useEffect(() => {
    let vivo = true;
    setEstado(null);
    setErrorEstado('');
    setErrores({});

    // Que el backend PREGUNTE al servidor por cada base, en vez de responder
    // con el estado del pool que tiene abierto. Es lo que hace que borrar una
    // base en SQL Server se vea aquí: sin esto el desplegable sigue
    // ofreciendo, y marcando como viva, una base que ya no existe.
    const revisar = ultimaRevision.current !== recarga;
    ultimaRevision.current = recarga;

    fetchEstadoAuth(dbId || undefined, revisar)
      .then((e) => {
        if (!vivo) return;
        setEstado(e);
        setBases(e.bases ?? []);

        // Primera carga: decidir con qué base se arranca. Gana la última que
        // funcionó en este navegador; si ya no está dada de alta, la que el
        // servidor marca por defecto.
        if (!dbId) {
          const lista = e.bases ?? [];
          const guardada = getBasePreferida();
          const elegida =
            lista.find((b) => b.db_id === guardada) ??
            lista.find((b) => b.por_defecto) ??
            lista[0];
          if (elegida) {
            setDbId(elegida.db_id);
            return; // el cambio de dbId vuelve a disparar este efecto
          }
        }

        // Sin cuentas en ESTA base, la única acción posible es crear la
        // primera. Con cuentas, se vuelve a "Entrar": mantener abierta la
        // pestaña de registro tras cambiar de base ofrecería algo que el
        // backend va a rechazar.
        setPestana(!e.hay_usuarios && e.bd_disponible ? 'registro' : 'entrar');
      })
      .catch((err) => vivo && setErrorEstado(err?.message ?? ''));

    return () => {
      vivo = false;
    };
  }, [dbId, recarga]);

  // Un solo objeto para los dos formularios: los campos compartidos (usuario,
  // contraseña) no se pierden al cambiar de pestaña.
  const [form, setForm] = useState({
    usuario: '',
    password: '',
    confirmar: '',
    email: '',
    categoria: 'Usuarios',
    estado: 'Activo',
    recordarme: true,
  });

  const formRef = useRef<HTMLFormElement>(null);

  const set = (campo: string, valor: any) => {
    setForm((f) => ({ ...f, [campo]: valor }));
    // Si el campo ya estaba marcado en rojo, se revalida al escribir para que
    // el error desaparezca en cuanto se corrige (y no al pulsar Enviar).
    if (errores[campo]) {
      setErrores((e) => {
        const { [campo]: _, ...resto } = e;
        return resto;
      });
    }
  };

  // ── Validación ────────────────────────────────────────────────
  //
  // Los límites salen de la tabla: usuario varchar(80), email varchar(160).
  // `email` acepta NULL en la BD, así que acá es opcional de verdad.
  const validar = (p: Pestana): Errores => {
    const e: Errores = {};
    const u = form.usuario.trim();

    if (!u) e.usuario = t('auth.errUserRequired');
    else if (u.length < 3) e.usuario = t('auth.errUserShort');
    else if (u.length > 80) e.usuario = t('auth.errUserLong');

    if (!form.password) e.password = t('auth.errPassRequired');
    else if (p === 'registro' && form.password.length < 8) {
      e.password = t('auth.errPassShort');
    }

    if (p === 'registro') {
      if (!form.confirmar) e.confirmar = t('auth.errConfirmRequired');
      else if (form.confirmar !== form.password) {
        e.confirmar = t('auth.errConfirmMismatch');
      }
      const mail = form.email.trim();
      if (mail) {
        if (mail.length > 160) e.email = t('auth.errMailLong');
        else if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(mail)) {
          e.email = t('auth.errMailInvalid');
        }
      }
    }
    return e;
  };

  // Validación al salir del campo (no en cada tecla: molesta mientras se
  // escribe y es la recomendación estándar de formularios).
  const alSalir = (campo: string) => {
    const e = validar(pestana);
    if (e[campo]) setErrores((prev) => ({ ...prev, [campo]: e[campo] }));
  };

  const cambiarPestana = (p: Pestana) => {
    setPestana(p);
    setMostrarOlvido(false);
    // Los errores del formulario anterior no aplican al nuevo: en "Entrar" la
    // contraseña no tiene mínimo de 8, por ejemplo.
    setErrores({});
  };

  const enviar = async (ev: React.FormEvent) => {
    ev.preventDefault();

    // Atajo: pasa de largo la validación y el retardo simulado.
    if (ATAJO_DEV) {
      navigate('/menu');
      return;
    }

    const e = validar(pestana);
    setErrores(e);

    if (Object.keys(e).length > 0) {
      // Foco al primer campo con error: sin esto, en móvil el error puede
      // quedar fuera de pantalla y parece que el botón no hizo nada.
      const primero = formRef.current?.querySelector<HTMLElement>(
        '[aria-invalid="true"]'
      );
      primero?.focus();
      primero?.scrollIntoView({ block: 'center', behavior: 'smooth' });
      return;
    }

    setEnviando(true);
    setErrores({});
    try {
      if (esRegistro) {
        // El PRIMER usuario del sistema se crea como Supervisor lo pida o no:
        // si no, no habría forma de tener un administrador inicial sin tocar
        // la base de datos a mano. Eso lo decide el backend.
        await registro({
          usuario: form.usuario.trim(),
          password: form.password,
          email: form.email.trim(),
          // La primera cuenta la fuerza el backend a Supervisor pase lo que
          // pase. Se manda ya así para que lo pedido y lo creado coincidan:
          // mandar 'Usuarios' y recibir un Supervisor es una sorpresa, aunque
          // sea la correcta.
          categoria: primeraCuenta ? 'Supervisor' : form.categoria,
          estado: form.estado,
          db_id: dbId || undefined,
        });
        // Recién creada la cuenta, se entra con ella: el usuario no tiene por
        // qué escribir dos veces lo mismo.
        await login(form.usuario.trim(), form.password, form.recordarme, dbId);
      } else {
        await login(form.usuario.trim(), form.password, form.recordarme, dbId);
      }
      await refrescarSesion();
      navigate('/menu');
    } catch (err: any) {
      // El backend ya manda mensajes redactados y en español (credenciales
      // incorrectas, cuenta inactiva, usuario repetido...). Se muestran tal
      // cual sobre el campo que corresponde.
      const msg = err?.message ?? 'No se pudo completar la operación.';
      const esDeUsuario = /usuario|cuenta|existe/i.test(msg);
      setErrores({ [esDeUsuario ? 'usuario' : 'password']: msg, _general: msg });
      // Con varias bases, "usuario o contraseña incorrectos" tiene DOS causas
      // igual de probables, y la segunda es invisible: haberse equivocado de
      // base. Se despliega el selector para que esa opción esté a la vista en
      // vez de dejar a alguien reescribiendo una contraseña que era correcta.
      if (bases.length > 1) setSelectorAbierto(true);
    } finally {
      setEnviando(false);
    }
  };

  const fuerza = useMemo(() => calcularFuerza(form.password), [form.password]);

  // ── Qué se puede hacer, según el estado del sistema ───────────
  const comprobando = estado === null && !errorEstado;
  const sinBackend = !!errorEstado;
  const sinBd = !!estado && !estado.bd_disponible;
  // Modo arranque: no hay cuentas todavía. El backend deja crear la primera
  // sin sesión y la fuerza a Supervisor.
  const primeraCuenta = !!estado && estado.bd_disponible && !estado.hay_usuarios;
  // Ya hay cuentas: `/auth/registro` exige Supervisor, así que un anónimo no
  // puede registrarse. Se oculta la pestaña en vez de dejarle chocar con un 403.
  const registroCerrado = !!estado && estado.hay_usuarios;

  const baseActual = bases.find((b) => b.db_id === dbId);

  // El desplegable se abre SOLO cuando la elección importa de verdad:
  //
  //   * la base elegida no responde -> insistir con las credenciales no va a
  //     servir de nada, el problema está una capa más arriba;
  //   * el último intento de entrar falló -> "usuario o contraseña
  //     incorrectos" es exactamente lo que se ve al equivocarse de base, y
  //     esa posibilidad tiene que estar delante de los ojos, no escondida.
  //
  // Fuera de esos dos casos se queda plegado: quien entra todos los días a la
  // misma base no debería tener que mirar un control que no va a tocar.
  useEffect(() => {
    if (bases.length <= 1) {
      setSelectorAbierto(false);
      return;
    }
    if (baseActual && !baseActual.conectado) setSelectorAbierto(true);
  }, [bases.length, baseActual?.db_id, baseActual?.conectado]);

  const esRegistro = pestana === 'registro' && !registroCerrado;
  // El formulario solo tiene sentido si hay dónde guardar o comprobar cuentas.
  const formularioUtil = !comprobando && !sinBackend && !sinBd;

  // Animación de entrada; se anula si el sistema pide menos movimiento.
  const aparecer = sinMovimiento
    ? {}
    : { initial: { opacity: 0, y: 12 }, animate: { opacity: 1, y: 0 } };

  return (
    <div className="mp-scroll mp-scroll-dark h-full w-full overflow-y-auto bg-slate-50 dark:bg-navy">
      <div className="grid min-h-full lg:grid-cols-[0.9fr_1.1fr]">

        {/* ══ Panel de marca (izquierda en escritorio) ══════════ */}
        <aside className="relative hidden overflow-hidden bg-gradient-to-br from-siemens-600 via-siemens-700 to-siemens-800 dark:from-siemens-800 dark:via-navy-soft dark:to-navy lg:flex lg:flex-col lg:justify-between lg:p-12">
          {/* Trama de puntos, la misma del editor de flujos */}
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-0 opacity-60"
            style={{
              backgroundImage:
                'radial-gradient(circle, rgba(255,255,255,0.13) 1px, transparent 1px)',
              backgroundSize: '22px 22px',
            }}
          />
          {/* Halo suave para que el bloque no se vea plano */}
          <div
            aria-hidden="true"
            className="pointer-events-none absolute -right-24 -top-24 h-80 w-80 rounded-full bg-white/10 blur-3xl"
          />

          <div className="relative">
            {/* El logo ES el título: repetir "Psi Core" debajo en texto sería
                decir el nombre dos veces. El <h1> envuelve la imagen y el alt
                le da su nombre accesible. */}
            <h1>
              <Logo variante="marca" />
            </h1>
            <p className="mt-8 max-w-md text-base leading-relaxed text-white/75">
              {t('auth.brandTagline')}
            </p>
          </div>

          <ul className="relative space-y-5">
            <Ventaja
              icon={<ActivityIcon className="h-5 w-5" />}
              titulo={t('auth.feat1Title')}
              texto={t('auth.feat1Desc')}
            />
            <Ventaja
              icon={<DatabaseIcon className="h-5 w-5" />}
              titulo={t('auth.feat2Title')}
              texto={t('auth.feat2Desc')}
            />
            <Ventaja
              icon={<CpuIcon className="h-5 w-5" />}
              titulo={t('auth.feat3Title')}
              texto={t('auth.feat3Desc')}
            />
          </ul>

          <p className="relative text-xs text-white/45">
            Siemens S7-1500 · Bosch Rexroth ctrlX CORE
          </p>
        </aside>

        {/* ══ Formulario (derecha) ═════════════════════════════ */}
        <main className="flex flex-col items-center justify-center px-5 py-10 sm:px-8 sm:py-12">
          <motion.div {...aparecer} className="w-full max-w-md">

            {/* Cabecera compacta: solo cuando el panel de marca no cabe */}
            <div className="mb-9 flex flex-col items-center text-center lg:hidden">
              <h1>
                <Logo variante="compacto" />
              </h1>
              <p className="mt-4 max-w-xs text-sm leading-relaxed text-slate-500 dark:text-slate-400">
                {t('auth.brandTagline')}
              </p>
            </div>

            {/* ── En qué base estás ────────────────────────────
                Va lo PRIMERO, antes incluso de los avisos: si la base elegida
                es la equivocada, todo lo que venga debajo (incluido "no hay
                base de datos") habla de la base equivocada.

                Plegado por defecto: quien siempre usa la misma no debería ver
                un desplegable que no va a tocar. Se abre solo cuando importa
                — ver `selectorAbierto`. */}
            {bases.length > 1 ? (
              <div className="mb-7">
                {!selectorAbierto ? (
                  <div className="flex items-center justify-between gap-3 rounded-xl border border-slate-200 bg-white px-3.5 py-2.5 dark:border-navy-slate dark:bg-navy-soft">
                    <span className="flex min-w-0 items-center gap-2.5">
                      <DatabaseIcon className="h-4 w-4 shrink-0 text-slate-400" />
                      <span className="truncate text-[13px] text-slate-500 dark:text-slate-400">
                        {t('auth.dbLabel')}{' '}
                        <span className="font-semibold text-navy dark:text-slate-100">
                          {baseActual?.nombre ?? t('auth.dbUnknown')}
                        </span>
                      </span>
                    </span>
                    <button
                      type="button"
                      onClick={() => setSelectorAbierto(true)}
                      className="shrink-0 rounded text-xs font-semibold text-siemens outline-none transition hover:text-siemens-600 focus-visible:ring-2 focus-visible:ring-siemens/40 dark:hover:text-siemens-300"
                    >
                      {t('auth.dbChange')}
                    </button>
                  </div>
                ) : (
                  <SelectorBase
                    bases={bases}
                    valor={dbId}
                    onChange={setDbId}
                    deshabilitado={comprobando || enviando}
                    t={t}
                  />
                )}
              </div>
            ) : (
              // Con una sola base no hay nada que decidir: basta el badge.
              estado?.bd?.configurada && <BadgeBd bd={estado.bd} t={t} />
            )}

            {/* ── Estado del sistema, ANTES de pedir nada ─────── */}
            {comprobando && (
              <PanelEstado
                tono="neutro"
                icon={<Loader2Icon className="h-4 w-4 animate-spin" />}
                texto={t('auth.checking')}
              />
            )}

            {sinBackend && (
              <PanelEstado
                tono="error"
                icon={<AlertCircleIcon className="h-4 w-4" />}
                titulo={t('auth.noBackend')}
                texto={errorEstado}
              />
            )}

            {/* Sin base configurada no se muestra un cartel y se deja al
                usuario encerrado fuera: se le da el formulario para
                configurarla. El backend permite esto solo mientras no exista
                ninguna cuenta; si ya las hay, responde 401 y el propio
                asistente enseña ese mensaje. */}
            {sinBd && (
              <div className="mb-7">
                <AsistenteArranque
                  // `estado.mensaje` va PRIMERO: cuando la base no
                  // responde, el backend lo rellena con el diagnóstico de
                  // esta misma comprobación ("La base 'X' no existe en el
                  // servidor…"). `bd.mensaje` es el último error guardado,
                  // que puede ser de hace horas.
                  motivo={estado?.mensaje || estado?.bd?.mensaje || t('auth.noDbBody')}
                  onListo={(creada) => {
                    setSelectorAbierto(false);
                    // Cambiarse a la conexión recién creada. Recargar la que
                    // estuviera seleccionada sería volver a mirar la base rota
                    // que motivó este asistente: guardar parecería no hacer
                    // nada. Si por lo que sea ya era la activa, basta con
                    // volver a preguntar.
                    if (creada) {
                      // Recordarla YA, no solo al entrar: sin esto, al
                      // recargar la página el login volvería a elegir la
                      // primera conexión de la lista —que puede ser una vieja
                      // y rota— y el asistente reaparecería sobre una base
                      // que acabas de configurar bien.
                      setBasePreferida(creada);
                    }
                    if (creada && creada !== dbId) setDbId(creada);
                    else setRecarga((n) => n + 1);
                  }}
                />
              </div>
            )}

            {primeraCuenta && (
              <PanelEstado
                tono="info"
                icon={<ShieldCheckIcon className="h-4 w-4" />}
                titulo={t('auth.firstAccountTitle')}
                texto={t('auth.firstAccountBody')}
              />
            )}

            {/* ── Pestañas ────────────────────────────────────── */}
            {/* Con cuentas ya creadas, `/auth/registro` exige Supervisor: se
                oculta la pestaña en vez de dejar chocar contra un 403. */}
            {formularioUtil && !registroCerrado && (
              <div
                role="tablist"
                aria-label={t('auth.tabsLabel')}
                className="mb-7 grid grid-cols-2 gap-1 rounded-xl bg-slate-200/60 p-1 dark:bg-navy-soft"
              >
                <Pestaña
                  activa={!esRegistro}
                  onClick={() => cambiarPestana('entrar')}
                  icon={<LogInIcon className="h-4 w-4" />}
                  label={t('auth.tabLogin')}
                  animar={!sinMovimiento}
                />
                <Pestaña
                  activa={esRegistro}
                  onClick={() => cambiarPestana('registro')}
                  icon={<UserPlusIcon className="h-4 w-4" />}
                  label={t('auth.tabSignup')}
                  animar={!sinMovimiento}
                />
              </div>
            )}

            {formularioUtil && (
              <>
            <h2 className="text-2xl font-bold text-navy dark:text-slate-100">
              {esRegistro ? t('auth.signupTitle') : t('auth.loginTitle')}
            </h2>
            <p className="mt-1.5 text-sm text-slate-500 dark:text-slate-400">
              {esRegistro ? t('auth.signupSubtitle') : t('auth.loginSubtitle')}
            </p>

            <form ref={formRef} onSubmit={enviar} noValidate className="mt-7 space-y-5">

              {/* Usuario — siempre */}
              <Campo
                id="usuario"
                label={t('auth.user')}
                icon={<UserIcon className="h-4 w-4" />}
                error={errores.usuario}
                requerido
              >
                <input
                  id="usuario"
                  name="usuario"
                  type="text"
                  autoComplete="username"
                  autoCapitalize="none"
                  spellCheck={false}
                  maxLength={80}
                  value={form.usuario}
                  onChange={(e) => set('usuario', e.target.value)}
                  onBlur={() => alSalir('usuario')}
                  placeholder={t('auth.userPlaceholder')}
                  aria-invalid={!!errores.usuario}
                  aria-describedby={errores.usuario ? 'usuario-error' : undefined}
                  className={claseInput(!!errores.usuario)}
                />
              </Campo>

              {/* Email — solo registro. En la BD acepta NULL, así que opcional */}
              {esRegistro && (
                <Campo
                  id="email"
                  label={t('auth.email')}
                  icon={<MailIcon className="h-4 w-4" />}
                  error={errores.email}
                  pista={t('auth.emailHint')}
                >
                  <input
                    id="email"
                    name="email"
                    type="email"
                    inputMode="email"
                    autoComplete="email"
                    autoCapitalize="none"
                    spellCheck={false}
                    maxLength={160}
                    value={form.email}
                    onChange={(e) => set('email', e.target.value)}
                    onBlur={() => alSalir('email')}
                    placeholder="operador@planta.com"
                    aria-invalid={!!errores.email}
                    aria-describedby={errores.email ? 'email-error' : 'email-pista'}
                    className={claseInput(!!errores.email)}
                  />
                </Campo>
              )}

              {/* Contraseña — siempre */}
              <Campo
                id="password"
                label={t('auth.password')}
                icon={<LockIcon className="h-4 w-4" />}
                error={errores.password}
                requerido
                accion={
                  !esRegistro ? (
                    <button
                      type="button"
                      onClick={() => setMostrarOlvido((v) => !v)}
                      aria-expanded={mostrarOlvido}
                      aria-controls="panel-olvido"
                      className="rounded text-xs font-semibold text-siemens outline-none transition hover:text-siemens-600 focus-visible:ring-2 focus-visible:ring-siemens/40 dark:hover:text-siemens-300"
                    >
                      {t('auth.forgot')}
                    </button>
                  ) : undefined
                }
              >
                <EntradaPassword
                  id="password"
                  name="password"
                  autoComplete={esRegistro ? 'new-password' : 'current-password'}
                  value={form.password}
                  onChange={(v) => set('password', v)}
                  onBlur={() => alSalir('password')}
                  error={!!errores.password}
                  placeholder="••••••••"
                  etiquetaVer={t('auth.showPass')}
                  etiquetaOcultar={t('auth.hidePass')}
                />
                {esRegistro && form.password.length > 0 && (
                  <MedidorFuerza nivel={fuerza} t={t} />
                )}
              </Campo>

              {/* No hay restablecimiento por correo, y decirlo es mejor que un
                  boton que no hace nada. La via real es que un Supervisor use
                  PATCH /auth/usuarios/<u>, que ademas cierra las sesiones. */}
              {!esRegistro && mostrarOlvido && (
                <div id="panel-olvido">
                  <PanelEstado
                    tono="info"
                    icon={<InfoIcon className="h-4 w-4" />}
                    titulo={t('auth.forgotTitle')}
                    texto={t('auth.forgotBody')}
                    onCerrar={() => setMostrarOlvido(false)}
                    etiquetaCerrar={t('auth.forgotClose')}
                  />
                </div>
              )}

              {/* Confirmar — solo registro */}
              {esRegistro && (
                <Campo
                  id="confirmar"
                  label={t('auth.confirm')}
                  icon={<ShieldCheckIcon className="h-4 w-4" />}
                  error={errores.confirmar}
                  requerido
                >
                  <EntradaPassword
                    id="confirmar"
                    name="confirmar"
                    autoComplete="new-password"
                    value={form.confirmar}
                    onChange={(v) => set('confirmar', v)}
                    onBlur={() => alSalir('confirmar')}
                    error={!!errores.confirmar}
                    placeholder="••••••••"
                    etiquetaVer={t('auth.showPass')}
                    etiquetaOcultar={t('auth.hidePass')}
                  />
                </Campo>
              )}

              {/* Categoría + Estado — solo registro, en dos columnas */}
              {esRegistro && (
                <fieldset className="grid grid-cols-1 gap-5 sm:grid-cols-2">
                  <legend className="sr-only">{t('auth.accessLegend')}</legend>

                  <Campo
                    id="categoria"
                    label={t('auth.category')}
                    icon={<ShieldCheckIcon className="h-4 w-4" />}
                    requerido
                    pista={primeraCuenta ? t('auth.categoryLocked') : undefined}
                  >
                    <Desplegable
                      id="categoria"
                      name="categoria"
                      // En modo arranque el backend fuerza Supervisor. Un
                      // desplegable activo ofrecería una elección que no se
                      // va a respetar.
                      value={primeraCuenta ? 'Supervisor' : form.categoria}
                      onChange={(v) => set('categoria', v)}
                      opciones={CATEGORIAS}
                      deshabilitado={primeraCuenta}
                    />
                  </Campo>

                  <Campo
                    id="estado"
                    label={t('auth.status')}
                    icon={
                      <span
                        aria-hidden="true"
                        className={`block h-2 w-2 rounded-full ${
                          form.estado === 'Activo' ? 'bg-state-ok' : 'bg-slate-400'
                        }`}
                      />
                    }
                    requerido
                  >
                    <Desplegable
                      id="estado"
                      name="estado"
                      value={form.estado}
                      onChange={(v) => set('estado', v)}
                      opciones={ESTADOS}
                    />
                  </Campo>
                </fieldset>
              )}

              {/* Algoritmo: dato del servidor, no un campo editable */}
              {esRegistro && (
                <div className="flex items-center gap-2.5 rounded-lg border border-slate-200 bg-slate-100/70 px-3 py-2.5 dark:border-navy-slate dark:bg-navy-soft/60">
                  <KeyRoundIcon className="h-4 w-4 shrink-0 text-slate-400" />
                  <p className="min-w-0 text-xs leading-relaxed text-slate-500 dark:text-slate-400">
                    {t('auth.algoNote')}
                  </p>
                </div>
              )}

              {/* Recordarme — solo login */}
              {!esRegistro && (
                <div>
                  <label className="flex w-fit cursor-pointer items-center gap-2.5 py-1 text-sm text-slate-600 dark:text-slate-400">
                    <input
                      type="checkbox"
                      checked={form.recordarme}
                      onChange={(e) => set('recordarme', e.target.checked)}
                      className="h-4 w-4 rounded border-slate-300 text-siemens focus:ring-2 focus:ring-siemens/40 dark:border-navy-slate dark:bg-navy"
                    />
                    {t('auth.remember')}
                  </label>
                  {/* Ahora decide de verdad el almacen del token
                      (localStorage vs sessionStorage). Antes no hacia nada. */}
                  <p className="mt-1 text-xs text-slate-400">
                    {t('auth.rememberHint')}
                  </p>
                </div>
              )}

              {/* Botón principal */}
              <button
                type="submit"
                disabled={enviando}
                className="flex min-h-[48px] w-full items-center justify-center gap-2 rounded-xl bg-siemens px-4 text-sm font-semibold text-white shadow-card outline-none transition hover:bg-siemens-600 focus-visible:ring-2 focus-visible:ring-siemens/50 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60 dark:focus-visible:ring-offset-navy"
              >
                {enviando ? (
                  <>
                    <Loader2Icon className="h-4 w-4 animate-spin" />
                    {esRegistro ? t('auth.creating') : t('auth.entering')}
                  </>
                ) : (
                  <>
                    {esRegistro ? t('auth.createBtn') : t('auth.enterBtn')}
                    <ArrowRightIcon className="h-4 w-4" />
                  </>
                )}
              </button>

              {/* Cambio de pestaña desde abajo. Se oculta junto con la
                  pestaña cuando el registro está cerrado: ofrecer el enlace
                  llevaría a un formulario que el backend va a rechazar. */}
              {!registroCerrado && (
                <p className="text-center text-sm text-slate-500 dark:text-slate-400">
                  {esRegistro ? t('auth.haveAccount') : t('auth.noAccount')}{' '}
                  <button
                    type="button"
                    onClick={() => cambiarPestana(esRegistro ? 'entrar' : 'registro')}
                    className="rounded font-semibold text-siemens outline-none transition hover:text-siemens-600 focus-visible:ring-2 focus-visible:ring-siemens/40 dark:hover:text-siemens-300"
                  >
                    {esRegistro ? t('auth.tabLogin') : t('auth.tabSignup')}
                  </button>
                </p>
              )}
            </form>

            {registroCerrado && (
              <div className="mt-6">
                <PanelEstado
                  tono="neutro"
                  icon={<UserPlusIcon className="h-4 w-4" />}
                  titulo={t('auth.signupClosedTitle')}
                  texto={t('auth.signupClosedBody')}
                />
              </div>
            )}
              </>
            )}

            {/* El aviso de "vista de diseño" desapareció: la pantalla YA
                valida contra la base de datos, y dejarlo puesto haría dudar de
                una sesión que sí es real. Solo queda la advertencia del atajo
                de desarrollo, que sí es peligrosa mientras esté activa. */}
            {ATAJO_DEV && (
              <div className="mt-8 flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2.5 dark:border-amber-500/20 dark:bg-amber-500/5">
                <AlertCircleIcon className="mt-px h-3.5 w-3.5 shrink-0 text-amber-500" />
                <p className="min-w-0 text-[11px] leading-relaxed text-amber-700 dark:text-amber-400">
                  {t('auth.devShortcut')}
                </p>
              </div>
            )}
          </motion.div>
        </main>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
// Piezas
// ═══════════════════════════════════════════════════════════════

/**
 * Wordmark de la aplicación, sobre una placa blanca.
 *
 * Se escala por ALTURA y el ancho sale solo (`w-auto`), que es como se trata
 * un logo horizontal: fijar el ancho lo deformaría o lo encogería.
 *
 * Si `LOGO_SRC` no existe, `onError` cambia a un wordmark dibujado con las
 * mismas proporciones, así la pantalla nunca se ve rota ni da un salto de
 * layout. En `npm run dev` un 404 devuelve el index.html de la SPA, que el
 * navegador tampoco puede decodificar como imagen: también dispara onError.
 */
function Logo({ variante }: { variante: 'marca' | 'compacto' }) {
  const [falló, setFalló] = useState(false);
  const esMarca = variante === 'marca';

  // Alturas. El logo recortado es 5.29:1, así que la altura decide el ancho:
  //   h-14 (56px) -> 296px   h-16 (64px) -> 338px   h-10 (40px) -> 212px
  // A `lg` el panel deja ~365px útiles, por eso h-16 se reserva para `xl`.
  const alto = esMarca ? 'h-14 xl:h-16' : 'h-9 sm:h-10';

  // Padding proporcional al logo (~0.3× su altura). Con el archivo ya
  // recortado, este es el único aire que se ve: si se sube, la placa vuelve a
  // parecer inflada como cuando el margen venía dentro del JPEG.
  const placa = [
    'inline-flex items-center justify-center rounded-2xl bg-white',
    esMarca ? 'px-6 py-4 shadow-2xl ring-1 ring-white/25' : 'px-4 py-2.5 shadow-card',
    // En claro la placa blanca se confundiría con el fondo slate-50: el borde
    // le devuelve el contorno. En oscuro no hace falta, contrasta sola.
    esMarca ? '' : 'ring-1 ring-slate-200 dark:ring-0',
  ].join(' ');

  if (falló) {
    return (
      <span className={placa} role="img" aria-label={APP_NAME}>
        <span
          className={`flex items-baseline gap-2 font-extrabold leading-none tracking-tight text-navy ${
            esMarca ? 'text-4xl xl:text-[2.75rem]' : 'text-xl'
          }`}
        >
          PsiCore
          <span className="text-siemens">Ψ</span>
        </span>
      </span>
    );
  }

  return (
    <span className={placa}>
      <img
        src={LOGO_SRC}
        alt={APP_NAME}
        onError={() => setFalló(true)}
        // w-auto: la altura manda, el ancho lo calcula el navegador con la
        // proporción real del archivo. Sin esto el logo se aplasta.
        className={`${alto} w-auto`}
      />
    </span>
  );
}

/** Fila del panel de marca: icono + título + una línea de texto. */
function Ventaja({
  icon,
  titulo,
  texto,
}: {
  icon: React.ReactNode;
  titulo: string;
  texto: string;
}) {
  return (
    <li className="flex gap-3.5">
      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-white/10 text-white ring-1 ring-white/15">
        {icon}
      </span>
      <div className="min-w-0">
        <p className="text-sm font-semibold text-white">{titulo}</p>
        <p className="mt-0.5 text-[13px] leading-relaxed text-white/60">{texto}</p>
      </div>
    </li>
  );
}

/** Botón de pestaña con indicador deslizante. */
function Pestaña({
  activa,
  onClick,
  icon,
  label,
  animar,
}: {
  activa: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
  animar: boolean;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={activa}
      onClick={onClick}
      className={`relative flex min-h-[44px] items-center justify-center gap-2 rounded-lg px-3 text-sm font-semibold outline-none transition-colors focus-visible:ring-2 focus-visible:ring-siemens/50 ${
        activa
          ? 'text-navy dark:text-slate-100'
          : 'text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200'
      }`}
    >
      {activa && animar && (
        <motion.span
          layoutId="pestana-activa"
          transition={{ type: 'spring', stiffness: 380, damping: 32 }}
          className="absolute inset-0 rounded-lg bg-white shadow-sm dark:bg-navy-slate"
        />
      )}
      {activa && !animar && (
        <span className="absolute inset-0 rounded-lg bg-white shadow-sm dark:bg-navy-slate" />
      )}
      <span className="relative flex items-center gap-2">
        {icon}
        {label}
      </span>
    </button>
  );
}

/** Etiqueta + icono + control + error. La estructura de todos los campos. */
function Campo({
  id,
  label,
  icon,
  error,
  pista,
  requerido,
  accion,
  children,
}: {
  id: string;
  label: string;
  icon: React.ReactNode;
  error?: string;
  pista?: string;
  requerido?: boolean;
  accion?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="mb-1.5 flex items-baseline justify-between gap-3">
        <label
          htmlFor={id}
          className="block text-[13px] font-semibold text-slate-600 dark:text-slate-300"
        >
          {label}
          {requerido && (
            <span className="ml-0.5 text-state-error" aria-hidden="true">
              *
            </span>
          )}
        </label>
        {accion}
      </div>

      <div className="relative">
        <span className="pointer-events-none absolute left-3.5 top-1/2 z-10 flex -translate-y-1/2 items-center text-slate-400">
          {icon}
        </span>
        {children}
      </div>

      {error ? (
        <p
          id={`${id}-error`}
          role="alert"
          className="mt-1.5 flex items-start gap-1.5 text-xs text-state-error"
        >
          <AlertCircleIcon className="mt-px h-3.5 w-3.5 shrink-0" />
          <span className="min-w-0">{error}</span>
        </p>
      ) : pista ? (
        <p id={`${id}-pista`} className="mt-1.5 text-xs text-slate-400">
          {pista}
        </p>
      ) : null}
    </div>
  );
}

/**
 * Clases del input.
 *
 * `text-base sm:text-sm`: 16px en móvil a propósito. Con menos de 16px, iOS
 * hace zoom automático al enfocar y descuadra toda la pantalla.
 * `min-h-[48px]`: por encima del mínimo táctil de 44px.
 */
function claseInput(hayError: boolean, conBotonDerecha = false): string {
  return [
    'block w-full min-h-[48px] rounded-xl border bg-white pl-11 text-base outline-none transition',
    conBotonDerecha ? 'pr-12' : 'pr-3.5',
    'text-navy placeholder-slate-400 sm:text-sm',
    'dark:bg-navy-soft dark:text-slate-100 dark:placeholder-slate-500',
    hayError
      ? 'border-state-error focus:border-state-error focus:ring-2 focus:ring-state-error/25'
      : 'border-slate-300 hover:border-slate-400 focus:border-siemens focus:ring-2 focus:ring-siemens/25 dark:border-navy-slate dark:hover:border-slate-600',
  ].join(' ');
}

/** Input de contraseña con el ojo de mostrar/ocultar. */
function EntradaPassword({
  id,
  name,
  value,
  onChange,
  onBlur,
  error,
  placeholder,
  autoComplete,
  etiquetaVer,
  etiquetaOcultar,
}: {
  id: string;
  name: string;
  value: string;
  onChange: (v: string) => void;
  onBlur: () => void;
  error: boolean;
  placeholder: string;
  autoComplete: string;
  etiquetaVer: string;
  etiquetaOcultar: string;
}) {
  const [visible, setVisible] = useState(false);
  return (
    <>
      <input
        id={id}
        name={name}
        type={visible ? 'text' : 'password'}
        autoComplete={autoComplete}
        autoCapitalize="none"
        spellCheck={false}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onBlur={onBlur}
        placeholder={placeholder}
        aria-invalid={error}
        aria-describedby={error ? `${id}-error` : undefined}
        className={claseInput(error, true)}
      />
      <button
        type="button"
        onClick={() => setVisible((v) => !v)}
        aria-label={visible ? etiquetaOcultar : etiquetaVer}
        aria-pressed={visible}
        // -mr-1 + p-2.5 dan 44px de área táctil sin agrandar el input.
        className="absolute right-2 top-1/2 flex h-10 w-10 -translate-y-1/2 items-center justify-center rounded-lg text-slate-400 outline-none transition hover:bg-slate-100 hover:text-slate-600 focus-visible:ring-2 focus-visible:ring-siemens/40 dark:hover:bg-navy-slate/50 dark:hover:text-slate-200"
      >
        {visible ? <EyeOffIcon className="h-4 w-4" /> : <EyeIcon className="h-4 w-4" />}
      </button>
    </>
  );
}

/** Desplegable con el mismo alto y estilo que los inputs. */
function Desplegable({
  id,
  name,
  value,
  onChange,
  opciones,
  deshabilitado = false,
}: {
  id: string;
  name: string;
  value: string;
  onChange: (v: string) => void;
  opciones: string[];
  deshabilitado?: boolean;
}) {
  return (
    <>
      <select
        id={id}
        name={name}
        value={value}
        disabled={deshabilitado}
        onChange={(e) => onChange(e.target.value)}
        className={`${claseInput(false, true)} appearance-none ${
          deshabilitado
            ? 'cursor-not-allowed opacity-60'
            : 'cursor-pointer'
        }`}
      >
        {opciones.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
      <ChevronDownIcon
        aria-hidden="true"
        className="pointer-events-none absolute right-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400"
      />
    </>
  );
}

/**
 * Panel de aviso: el mismo hueco para los cuatro estados del sistema.
 *
 * Los tres tonos NO se distinguen solo por color: cada uno lleva su propio
 * icono, que llega desde fuera. Quien no separa rojo de azul tiene que poder
 * leer igual de qué se le está avisando.
 */
function PanelEstado({
  tono,
  icon,
  titulo,
  texto,
  onCerrar,
  etiquetaCerrar,
}: {
  tono: 'neutro' | 'info' | 'error';
  icon: React.ReactNode;
  titulo?: string;
  texto: string;
  onCerrar?: () => void;
  etiquetaCerrar?: string;
}) {
  const estilos = {
    neutro:
      'border-slate-200 bg-slate-100/70 text-slate-600 dark:border-navy-slate dark:bg-navy-soft/60 dark:text-slate-300',
    info: 'border-siemens/25 bg-siemens/5 text-siemens-700 dark:border-siemens/25 dark:bg-siemens/10 dark:text-siemens-200',
    error:
      'border-state-error/30 bg-state-error/5 text-state-error dark:border-state-error/25 dark:bg-state-error/10',
  }[tono];

  return (
    <div
      role={tono === 'error' ? 'alert' : 'status'}
      className={`mb-6 flex items-start gap-2.5 rounded-xl border px-3.5 py-3 ${estilos}`}
    >
      <span className="mt-px shrink-0">{icon}</span>
      <div className="min-w-0 flex-1">
        {titulo && <p className="text-[13px] font-semibold">{titulo}</p>}
        <p className={`text-xs leading-relaxed ${titulo ? 'mt-1 opacity-90' : ''}`}>
          {texto}
        </p>
        {onCerrar && (
          <button
            type="button"
            onClick={onCerrar}
            className="mt-2 rounded text-xs font-semibold underline underline-offset-2 outline-none focus-visible:ring-2 focus-visible:ring-siemens/40"
          >
            {etiquetaCerrar}
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * Etiqueta corta para el `<option>`: qué le pasa a esa base.
 *
 * Dentro de un `<select>` nativo no se puede pintar un punto de color por
 * opción, así que el estado tiene que ir en el texto. Y tiene que ser el
 * estado CONCRETO: "sin conexión" a secas hizo que una base borrada en SQL
 * Server siguiera pareciendo un problema de red durante un buen rato.
 */
function etiquetaEstado(b: BaseDatos, t: (k: string) => string): string {
  switch (b.estado) {
    case 'base_no_existe':
    case 'ruta_no_existe':
      return t('auth.dbGone');
    case 'sin_servidor':
    case 'host_desconocido':
    case 'timeout':
      return t('auth.dbNoServer');
    case 'credenciales':
    case 'sin_permisos':
      return t('auth.dbBadCreds');
    default:
      return t('auth.dbOffline');
  }
}

/**
 * Selector de base de datos.
 *
 * No es un ajuste de conveniencia: **elige contra qué tabla `usuarios` se
 * autentica**, y cada base tiene la suya. Entrar con la opción equivocada
 * devuelve "usuario o contraseña incorrectos" aunque la contraseña sea
 * correcta, así que la pantalla hace tres cosas para que eso no sorprenda:
 *
 *   1. Lo pone ARRIBA del todo, antes de usuario y contraseña.
 *   2. Marca las bases que no responden, para no dejar intentar a ciegas.
 *   3. Recuerda la última que funcionó (`hmi.auth.db`, por navegador).
 */
function SelectorBase({
  bases,
  valor,
  onChange,
  deshabilitado,
  t,
}: {
  bases: BaseDatos[];
  valor: string;
  onChange: (v: string) => void;
  deshabilitado: boolean;
  t: (k: string) => string;
}) {
  const actual = bases.find((b) => b.db_id === valor);
  return (
    <div className="mb-7">
      <label
        htmlFor="db-origen"
        className="mb-1.5 block text-[13px] font-semibold text-slate-600 dark:text-slate-300"
      >
        {t('auth.dbPicker')}
      </label>

      <div className="relative">
        <span className="pointer-events-none absolute left-3.5 top-1/2 z-10 flex -translate-y-1/2 items-center text-slate-400">
          <DatabaseIcon className="h-4 w-4" />
        </span>
        <select
          id="db-origen"
          value={valor}
          disabled={deshabilitado}
          onChange={(e) => onChange(e.target.value)}
          className={`${claseInput(false, true)} appearance-none ${
            deshabilitado ? 'cursor-not-allowed opacity-60' : 'cursor-pointer'
          }`}
        >
          {bases.map((b) => (
            <option key={b.db_id} value={b.db_id}>
              {/* El estado va en el texto, no solo en un color: dentro de un
                  <select> nativo no se puede pintar un punto por opción. */}
              {b.nombre}
              {b.base_datos ? ` — ${b.base_datos}` : ''}
              {b.conectado ? '' : `  (${etiquetaEstado(b, t)})`}
            </option>
          ))}
        </select>
        <ChevronDownIcon
          aria-hidden="true"
          className="pointer-events-none absolute right-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400"
        />
      </div>

      <p className="mt-1.5 flex items-start gap-1.5 text-xs leading-relaxed text-slate-400">
        <InfoIcon className="mt-px h-3 w-3 shrink-0" />
        <span className="min-w-0">{t('auth.dbPickerHint')}</span>
      </p>

      {actual && !actual.conectado && (
        <p className="mt-1.5 flex items-start gap-1.5 text-xs leading-relaxed text-state-error">
          <AlertCircleIcon className="mt-px h-3 w-3 shrink-0" />
          <span className="min-w-0">
            {/* Una base BORRADA y un servidor apagado se veían igual —
                "no responde"— y no lo son: el primero se arregla desde
                esta pantalla, el segundo no. Cuando el backend sabe cuál
                de los dos es, se dice. */}
            {actual.estado === 'base_no_existe'
              ? t('auth.dbGoneHint')
              : actual.estado_titulo
                ? `${actual.estado_titulo}${
                    actual.estado_sugerencia ? ` ${actual.estado_sugerencia}` : ''
                  }`
                : t('auth.dbPickerOffline')}
          </span>
        </p>
      )}
    </div>
  );
}

/**
 * En qué base de datos vive tu cuenta.
 *
 * Existe porque el proyecto admite varias conexiones a la vez —una local y
 * otra en el servidor, por ejemplo— y la tabla `usuarios` solo vive en UNA de
 * ellas. Sin este dato a la vista, crear una cuenta y luego "perderla" al
 * cambiar de entorno parece un fallo del sistema, cuando en realidad la cuenta
 * sigue exactamente donde se creó.
 *
 * El punto de color dice si esa conexión responde AHORA. Y si `fijada` es
 * false, se advierte: significa que nadie puso `PLC_AUTH_DB_ID` y se está
 * usando la primera conexión de la lista, que puede cambiar sola el día que se
 * dé de alta otra base.
 */
function BadgeBd({ bd, t }: { bd: InfoBd; t: (k: string) => string }) {
  const viva = !!bd.conectado;
  return (
    <div className="mb-7 space-y-2">
      <div className="flex items-center gap-2.5 rounded-xl border border-slate-200 bg-white px-3.5 py-2.5 dark:border-navy-slate dark:bg-navy-soft">
        <DatabaseIcon className="h-4 w-4 shrink-0 text-slate-400" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-[13px] font-semibold text-navy dark:text-slate-100">
            <span className="font-normal text-slate-500 dark:text-slate-400">
              {t('auth.dbLabel')}{' '}
            </span>
            {bd.nombre || bd.db_id || t('auth.dbUnknown')}
          </p>
          <p className="truncate text-[11px] text-slate-400">
            {[bd.etiqueta_motor, bd.base_datos, bd.tabla]
              .filter(Boolean)
              .join(' · ')}
          </p>
        </div>
        <span className="flex shrink-0 items-center gap-1.5">
          <span
            aria-hidden="true"
            className={`h-2 w-2 rounded-full ${
              viva ? 'bg-state-ok' : 'bg-state-error'
            }`}
          />
          <span
            className={`text-[11px] font-medium ${
              viva ? 'text-state-ok' : 'text-state-error'
            }`}
          >
            {viva ? t('auth.dbOnline') : t('auth.dbOffline')}
          </span>
        </span>
      </div>

      {!bd.fijada && (
        <p className="flex items-start gap-1.5 px-1 text-[11px] leading-relaxed text-amber-600 dark:text-amber-400">
          <AlertCircleIcon className="mt-px h-3 w-3 shrink-0" />
          <span className="min-w-0">{t('auth.dbNotFixed')}</span>
        </p>
      )}
    </div>
  );
}

/**
 * Barra de fuerza de la contraseña.
 *
 * El nivel se comunica con color Y con texto: quien no distingue rojo de
 * verde tiene que poder leerlo igual.
 */
function MedidorFuerza({ nivel, t }: { nivel: number; t: (k: string) => string }) {
  const etiquetas = [
    t('auth.strength0'),
    t('auth.strength1'),
    t('auth.strength2'),
    t('auth.strength3'),
  ];
  const colores = ['bg-state-error', 'bg-state-warn', 'bg-siemens-400', 'bg-state-ok'];
  const idx = Math.max(0, Math.min(3, nivel - 1));

  return (
    <div className="mt-2.5">
      <div className="flex gap-1.5" aria-hidden="true">
        {[0, 1, 2, 3].map((i) => (
          <span
            key={i}
            className={`h-1 flex-1 rounded-full transition-colors duration-200 ${
              i < nivel ? colores[idx] : 'bg-slate-200 dark:bg-navy-slate'
            }`}
          />
        ))}
      </div>
      <p className="mt-1.5 text-xs text-slate-400" aria-live="polite">
        {etiquetas[idx]}
      </p>
    </div>
  );
}

/**
 * Puntaje 1-4 de la contraseña.
 *
 * Heurística simple y suficiente para una pista visual: longitud + variedad
 * de tipos de carácter. La validación de verdad la hará el backend.
 */
function calcularFuerza(pass: string): number {
  if (!pass) return 0;
  let p = 0;
  if (pass.length >= 8) p++;
  if (pass.length >= 12) p++;
  if (/[a-z]/.test(pass) && /[A-Z]/.test(pass)) p++;
  if (/\d/.test(pass) && /[^A-Za-z0-9]/.test(pass)) p++;
  return Math.max(1, Math.min(4, p));
}
