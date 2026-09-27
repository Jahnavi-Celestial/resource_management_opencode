import { graphql } from '@/graphql'

export const EquipmentDocument = graphql(/* GraphQL */ `
  query Equipment(
    $page: Int!
    $pageSize: Int!
    $search: String
    $activeOnly: Boolean! = false
    $sort: SortInput
  ) {
    equipment(
      page: $page
      pageSize: $pageSize
      search: $search
      activeOnly: $activeOnly
      sort: $sort
    ) {
      totalCount
      items {
        id
        name
        quantityAvailable
        isActive
        createdAt
      }
    }
  }
`)

export const CreateEquipmentDocument = graphql(/* GraphQL */ `
  mutation CreateEquipment($input: CreateEquipmentInput!) {
    createEquipment(input: $input) {
      id
      name
    }
  }
`)

export const UpdateEquipmentDocument = graphql(/* GraphQL */ `
  mutation UpdateEquipment($input: UpdateEquipmentInput!) {
    updateEquipment(input: $input) {
      id
      name
    }
  }
`)
