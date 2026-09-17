// =========================================================================
// RutaProtegida.tsx
// Envuelve una ruta para que solo se abra con sesión válida.
//
// ANTES no existía: escribir `/designer` en la barra de direcciones abría el
// Diseñador entero sin haber entrado. Las llamadas a la API fallaban con 401,
// así que no se podía hacer daño — pero la pantalla se montaba, pedía datos,
// mostraba errores y dejaba a la persona en un sitio donde no debería estar.
//
// Esto NO sustituye a los permisos del backend, los complementa:
//
//   backend  -> IMPIDE (401/403 en cada endpoint). Es la seguridad real.
//   esto     -> EVITA llegar. Es la experiencia de uso.
//
// Quien quiera saltárselo puede llamar a la API con curl, y ahí se topa con
// el backend. Por eso este componente puede ser "solo" cortesía sin que eso
// abra ningún agujero.
// =========================================================================
import React from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { Loader2Icon, ShieldAlertIcon } from 'lucide-react';
import { useAppStore } from '../../context/AppStore';
import { Rol } from '../../services/authApi';

interface Props {
  children: React.ReactNode;
  /**
   * Rol mínimo. Si se omite, basta con estar autenticado.
   *
   * Mismo orden que en el backend: Supervisor > Administradores > Usuarios >
   * Invitado.
   */
  rolMinimo?: Rol;
}

const ORDEN: Rol[] = ['Supervisor', 'Administradores', 'Usuarios', 'Invitado'];

function alcanza(mio: string | undefined, minimo: Rol): boolean {
  const i = ORDEN.indexOf((mio ?? '') as Rol);
  const j = ORDEN.indexOf(minimo);
  // Un rol desconocido se trata como el más bajo, igual que en el backend:
  // si alguien escribe 'Jefazo' a mano en la columna, obtiene permisos de
  // invitado, no todos.
  return i >= 0 && i <= j;
}

/**
 * ¿Esta persona, en esta pantalla, solo debe ver el runtime?
 *
 * Un VISOR (otro equipo de la red, lo decide el servidor por la IP) con una
 * categoría por debajo de Administradores no tiene nada que hacer en el
 * menú, la configuración o el Diseñador: su puesto es el HMI en marcha. Se
 * le manda a `/preview` en vez de enseñarle un menú con cuatro tarjetas que
 * en el mejor de los casos le devuelven un 403.
 *
 * Un Administrador o Supervisor que entra desde otro equipo SÍ puede seguir
 * llegando a las pantallas de administración escribiendo la ruta: es lo que
 * permite tomar el control o revisar la actividad desde un portátil sin ir
 * al servidor. Al entrar, eso sí, también va al runtime (ver Login.tsx).
 */
export function soloRuntime(
  esVisor: boolean | null,
  categoria: string | undefined
): boolean {
  return esVisor === true && !alcanza(categoria, 'Administradores');
}

export function RutaProtegida({ children, rolMinimo }: Props) {
  const { sesion, authRequerida, comprobandoSesion, esVisor } = useAppStore();
  const donde = useLocation();

  // Mientras se pregunta al servidor quién soy, NO se decide nada. Sin este
  // estado, al recargar la página con una sesión perfectamente válida se
  // rebotaría al login durante el instante en que `sesion` todavía es null.
  if (comprobandoSesion) {
    return (
      <div className="flex h-full w-full items-center justify-center bg-slate-50 dark:bg-navy">
        <div className="flex items-center gap-2 text-sm text-slate-400">
          <Loader2Icon className="h-4 w-4 animate-spin" />
          Comprobando la sesión…
        </div>
      </div>
    );
  }

  // Instalación sin autenticación (`PLC_AUTH_REQUERIDA=false`): abierto, para
  // no dejar fuera a quien nunca creó cuentas.
  //
  // Pero SOLO mientras no haya nadie dentro. En cuanto alguien inicia sesión,
  // su rol manda aunque la autenticación no sea obligatoria: si no, un
  // operario que ha entrado como `Usuarios` seguiría abriendo el Diseñador,
  // que es justo lo que este componente existe para evitar. Antes se salía
  // aquí sin mirar el rol, y `rolMinimo` no servía de nada en esa
  // configuración — que es la de una instalación recién montada.
  if (!authRequerida && !sesion) return <>{children}</>;

  if (!sesion) {
    // `state.desde` permite volver a donde iba después de entrar, en vez de
    // dejarlo siempre en el menú.
    return <Navigate to="/" replace state={{ desde: donde.pathname }} />;
  }

  // Un visor de operación no ve nada más que el runtime. El permiso real lo
  // aplica el backend igual; esto evita enseñar un menú al que no se puede
  // entrar.
  if (soloRuntime(esVisor, sesion.categoria)) {
    return <Navigate to="/preview" replace />;
  }

  if (rolMinimo && !alcanza(sesion.categoria, rolMinimo)) {
    return (
      <div className="flex h-full w-full items-center justify-center bg-slate-50 p-6 dark:bg-navy">
        <div className="max-w-sm text-center">
          <ShieldAlertIcon className="mx-auto mb-3 h-10 w-10 text-slate-400" />
          <h2 className="text-lg font-bold text-navy dark:text-slate-100">
            No tienes acceso a esta pantalla
          </h2>
          <p className="mt-2 text-sm text-slate-500 dark:text-slate-400">
            Tu categoría es <strong>{sesion.categoria}</strong> y aquí hace
            falta al menos <strong>{rolMinimo}</strong>. Pídeselo a un
            Supervisor.
          </p>
        </div>
      </div>
    );
  }

  return <>{children}</>;
}
