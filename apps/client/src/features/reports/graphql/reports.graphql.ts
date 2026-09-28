import { graphql } from '@/graphql'

export const MostBookedRoomsDocument = graphql(/* GraphQL */ `
  query MostBookedRooms($limit: Int, $range: ReportRangeInput!) {
    mostBookedRooms(limit: $limit, range: $range) {
      roomId
      roomName
      location
      capacity
      bookingCount
    }
  }
`)

export const BookingsPerEmployeeDocument = graphql(/* GraphQL */ `
  query BookingsPerEmployee($limit: Int, $range: ReportRangeInput) {
    bookingsPerEmployee(limit: $limit, range: $range) {
      employeeId
      displayName
      email
      totalCount
      pendingCount
      approvedCount
      rejectedCount
      cancelledCount
      completedCount
    }
  }
`)

export const EquipmentUsageDocument = graphql(/* GraphQL */ `
  query EquipmentUsage($limit: Int, $statuses: [ReportBookingStatus!], $range: ReportRangeInput!) {
    equipmentUsage(limit: $limit, statuses: $statuses, range: $range) {
      equipmentId
      equipmentName
      quantityAvailable
      bookingCount
      totalQuantityCommitted
      totalQuantityHours
    }
  }
`)

export const MonthlyBookingStatisticsDocument = graphql(/* GraphQL */ `
  query MonthlyBookingStatistics($limit: Int, $range: ReportRangeInput!) {
    monthlyBookingStatistics(limit: $limit, range: $range) {
      month
      created
      approved
      rejected
      cancelled
    }
  }
`)
