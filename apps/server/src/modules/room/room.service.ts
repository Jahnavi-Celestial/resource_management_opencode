import type { DataSource } from 'typeorm'
import { isUniqueViolation } from '../../common/db/pg-error'
import { ConflictError } from '../../common/errors/conflict-error'
import { NotFoundError } from '../../common/errors/not-found-error'
import type { CreateRoomInput, RoomListArgs, UpdateRoomInput } from './room.inputs'
import { MeetingRoom } from './room.entity'
import { RoomRepository } from './room.repository'

const ROOM_NAME_LOCATION_UNIQUE_CONSTRAINT = 'uq_room_name_location'

function roomNameLocationInUseError(): ConflictError {
  return new ConflictError('A room with this name already exists at this location')
}

export class RoomService {
  private readonly repository: RoomRepository

  constructor(private readonly dataSource: DataSource) {
    this.repository = new RoomRepository(dataSource.manager)
  }

  async create(input: CreateRoomInput): Promise<MeetingRoom> {
    const name = input.name.trim()
    const location = input.location.trim()
    const existing = await this.repository.findByNameAndLocation(name, location)
    if (existing !== null) throw roomNameLocationInUseError()
    try {
      return await this.repository.insert({ name, location, capacity: input.capacity })
    } catch (error: unknown) {
      if (isUniqueViolation(error, ROOM_NAME_LOCATION_UNIQUE_CONSTRAINT)) throw roomNameLocationInUseError()
      throw error
    }
  }

  async update(input: UpdateRoomInput): Promise<MeetingRoom> {
    const room = await this.repository.findById(input.id)
    if (room === null) throw new NotFoundError('Room not found')

    const newName = input.name !== undefined ? input.name.trim() : room.name
    const newLocation = input.location !== undefined ? input.location.trim() : room.location
    const nameChanged = newName !== room.name
    const locationChanged = newLocation !== room.location

    if (nameChanged || locationChanged) {
      const existing = await this.repository.findByNameAndLocation(newName, newLocation)
      if (existing !== null && existing.id !== room.id) throw roomNameLocationInUseError()
    }

    room.name = newName
    room.location = newLocation
    if (input.capacity !== undefined) room.capacity = input.capacity
    if (input.isActive !== undefined) room.isActive = input.isActive

    try {
      return await this.repository.save(room)
    } catch (error: unknown) {
      if (isUniqueViolation(error, ROOM_NAME_LOCATION_UNIQUE_CONSTRAINT)) throw roomNameLocationInUseError()
      throw error
    }
  }

  async list(args: RoomListArgs): Promise<{ items: MeetingRoom[]; total: number }> {
    return this.repository.list(args)
  }
}
