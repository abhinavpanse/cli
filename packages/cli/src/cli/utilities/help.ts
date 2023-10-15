import {Command, Help, CommandHelp} from '@oclif/core'
import chalk from 'chalk'

let {dim} = chalk

class CustomCommandHelp extends CommandHelp {
  protected flags(flags: Array<Command.Flag.Any>): [string, string | undefined][] | undefined {
    if (flags.length === 0) return

    return flags.map((flag) => {
      const left = this.flagHelpLabel(flag)

      let right = flag.summary || flag.description || ''
      if (flag.type === 'option' && flag.default) {
        right = `[default: ${flag.default}] ${right}`
      }

      if (flag.required) right = `(required) ${right}`

      if (flag.type === 'option' && flag.options && !flag.helpValue && !this.opts.showFlagOptionsInTitle) {
        right += `\n<options: ${flag.options.join('|')}>`
      }

      if (flag.env) right = `${right} (Env: ${flag.env})`

      return [left, dim(right.trim())]
    })
  }}

export default class CustomHelp extends Help{
  protected override CommandHelpClass: typeof CommandHelp = CustomCommandHelp
}
