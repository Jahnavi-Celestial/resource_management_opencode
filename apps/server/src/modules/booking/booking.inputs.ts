import { IsArray, IsDate, IsDefined, IsInt, IsNotEmpty, IsOptional, IsString, IsUUID, Min, ValidateNested, validate } from 'class-validator'
import { InputValidationError, validationErrorsToFieldErrors } from '../../common/errors/field-errors'

export class CreateBookingEquipmentInput {
  @IsDefined()
  @IsUUID()
  equipmentId!: string

  @IsDefined()
  @IsInt()
  @Min(1)
  quantity!: number
}

export class CreateBookingInput {
  @IsDefined()
  @IsUUID()
  roomId!: string

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  equipment?: CreateBookingEquipmentInput[]

  @IsDefined()
  @IsDate()
  startTime!: Date

  @IsDefined()
  @IsDate()
  endTime!: Date

  @IsDefined()
  @IsString()
  @IsNotEmpty()
  purpose!: string

  @IsDefined()
  @IsInt()
  @Min(1)
  numberOfAttendees!: number
}

export async function validateCreateBookingInput(input: CreateBookingInput): Promise<CreateBookingInput> {
  const instance = Object.assign(new CreateBookingInput(), input)
  if (input?.equipment !== undefined) {
    instance.equipment = input.equipment.map((item) => Object.assign(new CreateBookingEquipmentInput(), item))
  }
  if (typeof input?.startTime === 'string') {
    instance.startTime = new Date(input.startTime)
  }
  if (typeof input?.endTime === 'string') {
    instance.endTime = new Date(input.endTime)
  }

  const validationErrors = await validate(instance, {
    whitelist: true,
    validationError: { target: false, value: false },
  })

  if (validationErrors.length > 0) {
    throw new InputValidationError(validationErrorsToFieldErrors(validationErrors))
  }

  return instance
}
