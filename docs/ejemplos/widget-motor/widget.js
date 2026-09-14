// Motor rotativo — lo poco que no puede hacer el CSS.
//
// La velocidad de giro y el rótulo de alarma salen de las variables CSS
// (ver widget.css). Aquí solo quedan dos cosas:
//   · arrancar o parar la animación según la variable principal;
//   · enseñar si la última orden llegó al PLC.

window.onWidgetUpdate = function (w) {
  var rotor = document.getElementById('rotor');
  if (rotor) {
    // `w.on` es la variable PRINCIPAL interpretada como sí/no. Pausar en vez
    // de quitar la animación conserva el ángulo: al volver a arrancar, el
    // motor sigue donde estaba en lugar de dar un salto.
    rotor.style.animationPlayState = w.on ? 'running' : 'paused';
  }
};

// Respuesta del anfitrión a cada `escribir()`. Sin esto, el operario pulsa
// MARCHA y no sabe si la orden salió o la rechazó el servidor.
window.onWidgetEscrito = function (r) {
  var caja = document.getElementById('resultado');
  if (!caja) return;
  caja.textContent = r.ok ? 'orden enviada' : r.error;
  caja.style.color = r.ok ? 'inherit' : '#dc2626';
  clearTimeout(window.__limpiar);
  window.__limpiar = setTimeout(function () { caja.textContent = ''; }, 4000);
};
