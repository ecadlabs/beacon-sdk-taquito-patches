import { MatrixMessageType } from './MatrixMessage'

export interface MatrixStateEventMessageText extends MatrixStateEventMessage {
  type: 'm.room.message'
  content: {
    msgtype: MatrixMessageType.TEXT
    body: string
  }
}

export interface MatrixStateEventMessageContent {
  msgtype: string
  body: unknown
  [key: string]: unknown
}

export interface MatrixStateEventMessage extends MatrixStateEvent {
  type: 'm.room.message'
  content: MatrixStateEventMessageContent
}

export interface MatrixStateEvent {
  type: string
  state_key?: string
  sender: string
  content: unknown
  event_id?: string
  origin_server_ts: number
}
