// Ventilador — lo único que no puede hacer el CSS.
//
// La velocidad de giro y el apagado visual salen de las variables CSS
// (ver widget.css). Aquí solo queda arrancar y parar la animación.

window.onWidgetUpdate = function (w) {
  var aspas = document.getElementById('aspas');
  if (!aspas) return;

  // `w.vars.marcha` es la variable DISCRETA que se haya enlazado en el
  // Diseñador. `.on` ya viene interpretada como sí/no, así que aquí no hay
  // que saber si el tag era un Bool, un Int o un Word.
  var marcha = w.vars && w.vars.marcha ? w.vars.marcha.on : false;

  // PAUSAR, no quitar la animación: al volver a arrancar, el ventilador sigue
  // desde el ángulo en el que se quedó en vez de dar un salto hasta cero.
  aspas.style.animationPlayState = marcha ? 'running' : 'paused';
};
