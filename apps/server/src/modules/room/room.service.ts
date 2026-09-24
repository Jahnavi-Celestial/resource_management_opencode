import type { DataSource } from 'typeorm'
import { NotFoundError } from '../../common/errors/not-found-error'
import type { CreateRoomInput, RoomListArgs, UpdateRoomInput } from './room.inputs'
import { MeetingRoom } from './room.entity'
import { RoomRepository } from './room.repository'

export class RoomService {
  private readonly repository: RoomRepository

  constructor(private readonly dataSource: DataSource) {
    this.repository = new RoomRepository(dataSource.manager)
  }

  async create(input: CreateRoomInput): Promise<MeetingRoom> {
    return this.repository.insert({
      name: input.name.trim(),
      location: input.location.trim(),
      capacity: input.capacity,
    })
  }

  async update(input: UpdateRoomInput): Promise<MeetingRoom> {
    const room = await this.repository.findById(input.id)
    if (room === null) throw new NotFoundError('Room not found')

    if (input.name !== undefined) room.name = input.name.trim()
    if (input.location !== undefined) room.location = input.location.trim()
    if (input.capacity !== undefined) room.capacity = input.capacity
    if (input.isActive !== undefined) room.isActive = input.isActive

    return this.repository.save(room)
  }

  async list(args: RoomListArgs): Promise<{ items: MeetingRoom[]; total: number }> {
    return this.repository.list(args)
  }
}
