import { createWidget, widget, align, prop } from '@zos/ui'
import { back } from '@zos/router'
import { setPageBrightTime, pauseDropWristScreenOff } from '@zos/display'
import { createSyncClient } from '../libs/sync'

const LABELS = {
  scanning: 'Buscando PC…',
  connecting: 'Conectando…',
  preparing: 'Preparando…',
  hello: 'Saludando…',
  sending: 'Enviando',
  retry: 'Reintentando',
  done: 'Listo',
  error: 'Error',
}

function keepScreenOn() {
  try {
    setPageBrightTime({ brightTime: 120000 })
    pauseDropWristScreenOff({ duration: 120000 })
  } catch (e) {}
}

// Module-level: on-device, assignments to `this` inside Page methods do not
// persist (reads resolve against the original config object), so the client
// must not live on the page instance.
let client = null

Page({
  widgets: {},

  build() {
    const self = this
    keepScreenOn()

    createWidget(widget.TEXT, {
      x: 0, y: 60, w: 480, h: 40,
      text: 'SYNC',
      text_size: 30, color: 0x999999,
      align_h: align.CENTER_H, align_v: align.CENTER_V,
    })

    this.widgets.status = createWidget(widget.TEXT, {
      x: 30, y: 140, w: 420, h: 60,
      text: 'Iniciando…',
      text_size: 36, color: 0xffffff,
      align_h: align.CENTER_H, align_v: align.CENTER_V,
    })

    this.widgets.detail = createWidget(widget.TEXT, {
      x: 30, y: 205, w: 420, h: 80,
      text: '',
      text_size: 26, color: 0xaaaaaa,
      align_h: align.CENTER_H, align_v: align.CENTER_V,
      text_style: 3, // wrap
    })

    createWidget(widget.BUTTON, {
      x: 60, y: 320, w: 170, h: 64,
      text: 'REINTENTAR', text_size: 26,
      normal_color: 0x1a4f8a, press_color: 0x123a66, radius: 32,
      click_func: () => self.restart(),
    })

    createWidget(widget.BUTTON, {
      x: 250, y: 320, w: 170, h: 64,
      text: 'VOLVER', text_size: 26,
      normal_color: 0x333333, press_color: 0x555555, radius: 32,
      click_func: () => {
        if (client) client.cancel()
        back()
      },
    })

    this.restart()
  },

  restart() {
    const self = this
    try {
      if (client) client.cancel()
      client = createSyncClient((state, detail) => {
        self.widgets.status.setProperty(prop.TEXT, LABELS[state] || state)
        self.widgets.detail.setProperty(prop.TEXT, detail || '')
      })
      client.start()
    } catch (e) {
      // surface anything that escapes so the screen never freezes silently
      this.widgets.status.setProperty(prop.TEXT, LABELS.error)
      this.widgets.detail.setProperty(prop.TEXT, 'exc: ' + (e && e.message ? e.message : String(e)))
    }
  },

  onDestroy() {
    if (client) {
      client.cancel()
      client = null
    }
  },
})
