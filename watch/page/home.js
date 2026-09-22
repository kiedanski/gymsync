import { createWidget, widget, align, prop } from '@zos/ui'
import { push } from '@zos/router'
import { Vibrator, VIBRATOR_SCENE_SHORT_MIDDLE } from '@zos/sensor'
import { KG_MIN, KG_MAX, KG_DEFAULT } from '../libs/config'
import { lastKg, pushWeight, pendingCount, lastSyncTs } from '../libs/store'

const COLOR_BG_BTN = 0x333333
const COLOR_ACCENT = 0x00a86b

function vibrate() {
  try {
    const vib = new Vibrator()
    if (VIBRATOR_SCENE_SHORT_MIDDLE !== undefined) {
      vib.setMode(VIBRATOR_SCENE_SHORT_MIDDLE)
    }
    vib.start()
  } catch (e) {}
}

Page({
  state: { kg: KG_DEFAULT },
  widgets: {},

  onInit() {
    const last = lastKg()
    if (last !== null) this.state.kg = last
  },

  build() {
    const self = this

    createWidget(widget.TEXT, {
      x: 0, y: 36, w: 480, h: 40,
      text: 'PESO CORPORAL',
      text_size: 28, color: 0x999999,
      align_h: align.CENTER_H, align_v: align.CENTER_V,
    })

    this.widgets.value = createWidget(widget.TEXT, {
      x: 0, y: 90, w: 480, h: 110,
      text: this.fmt(),
      text_size: 96, color: 0xffffff,
      align_h: align.CENTER_H, align_v: align.CENTER_V,
    })

    const steps = [
      { label: '-1', delta: -1.0 },
      { label: '-.1', delta: -0.1 },
      { label: '+.1', delta: +0.1 },
      { label: '+1', delta: +1.0 },
    ]
    for (let n = 0; n < steps.length; n++) {
      const step = steps[n]
      createWidget(widget.BUTTON, {
        x: 24 + n * 110, y: 215, w: 102, h: 64,
        text: step.label, text_size: 32,
        normal_color: COLOR_BG_BTN, press_color: 0x555555, radius: 32,
        click_func: () => self.adjust(step.delta),
      })
    }

    createWidget(widget.BUTTON, {
      x: 100, y: 296, w: 280, h: 72,
      text: 'GUARDAR', text_size: 36,
      normal_color: COLOR_ACCENT, press_color: 0x007a4d, radius: 36,
      click_func: () => self.save(),
    })

    this.widgets.status = createWidget(widget.TEXT, {
      x: 0, y: 376, w: 480, h: 34,
      text: this.statusLine(),
      text_size: 24, color: 0x888888,
      align_h: align.CENTER_H, align_v: align.CENTER_V,
    })

    createWidget(widget.BUTTON, {
      x: 150, y: 412, w: 180, h: 56,
      text: 'SYNC', text_size: 30,
      normal_color: 0x1a4f8a, press_color: 0x123a66, radius: 28,
      click_func: () => push({ url: 'page/sync' }),
    })
  },

  fmt() {
    return this.state.kg.toFixed(1) + ' kg'
  },

  statusLine() {
    const pending = pendingCount()
    const last = lastSyncTs()
    let line = pending === 0 ? 'nada pendiente' : pending + ' pendiente' + (pending === 1 ? '' : 's')
    if (last) {
      const hours = Math.floor((Date.now() / 1000 - last) / 3600)
      line += ' · sync hace ' + (hours < 1 ? '<1 h' : hours + ' h')
    }
    return line
  },

  adjust(delta) {
    let kg = Math.round((this.state.kg + delta) * 10) / 10
    if (kg < KG_MIN) kg = KG_MIN
    if (kg > KG_MAX) kg = KG_MAX
    this.state.kg = kg
    this.widgets.value.setProperty(prop.TEXT, this.fmt())
  },

  save() {
    pushWeight(this.state.kg)
    vibrate()
    this.widgets.status.setProperty(prop.TEXT, this.statusLine())
  },
})
