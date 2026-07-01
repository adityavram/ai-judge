import type { FlowSheet } from '../api/client'
import './FlowView.css'

interface FlowViewProps {
  flow: FlowSheet
}

const SPEECH_ORDER = ['PMC', 'LOC', 'MG', 'MO', 'LOR', 'PMR']

export function FlowView({ flow }: FlowViewProps) {
  return (
    <div className="flow-view">
      <h2>Flow Sheet</h2>
      <div className="flow-table-wrapper">
        <table className="flow-table">
          <thead>
            <tr>
              <th className="clash-col">Clash</th>
              {SPEECH_ORDER.map((speech) => (
                <th key={speech} className={`speech-col ${speech}`}>{speech}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {flow.clashes.map((clash, i) => (
              <tr key={i}>
                <td className="clash-name">{clash.name}</td>
                {SPEECH_ORDER.map((speech) => {
                  const args = clash.args.filter((a) => a.speech === speech)
                  return (
                    <td key={speech} className={`speech-cell ${args[0]?.side?.toLowerCase() ?? ''}`}>
                      {args.map((arg, j) => (
                        <div key={j} className="flow-arg">
                          <div className="arg-tag">{arg.tag}</div>
                          {arg.components.map((comp, k) => (
                            <div key={k} className="arg-component">
                              <span className="comp-label">{comp.label}</span>
                              <span className="comp-text">{comp.text}</span>
                            </div>
                          ))}
                        </div>
                      ))}
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}