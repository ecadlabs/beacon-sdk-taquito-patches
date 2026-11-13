/** This SDK sends an empty JSON object when joining a Matrix room. */
export type MatrixRoomJoinRequest = Record<string, never>

export interface MatrixRoomJoinResponse {
  type?: 'room_join'
  room_id: string
}
