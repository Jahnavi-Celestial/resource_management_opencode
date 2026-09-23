1. Project Overview

The Resource Booking Management System is a full stack application designed to streamline workplace resource allocation. The system handles employees booking for meeting rooms and equipment, featuring dynamic role-based access control (RBAC), advanced backend optimization and a modular React frontend.

2. Core Features
Centralized Resources Management: Consolidates room scheduling, equipment tracking, employee authorization into a single platform.
Conflict Prevention: Automatically validates scheduling overlaps and inventory caps to eliminate double-booking.
Enterprise Security: Implements dynamic permissions and roles and secure JWT authentication.
Advanced Booking Engine: Enforces business constraints including time overlap prevention, room capacity checks, and equipment availability validation.
Audit Trails & Logging: Automatically records critical lifecycle actions.
Automated Background Jobs: Utilizes node-cron for scheduling automated status updates.
Notification Services: Real-time in-app notifications over WebSockets, plus transactional email for key events.
Analytical Reporting Module: Dedicated reporting queries built via ORM query builders — Most Booked Room, Bookings Per Employee, Equipment Usage reports and Monthly Booking Statistics.
Generic Frontend Components: A reusable data-table supporting server-side pagination, searching, sorting, filtering and dynamic columns, plus a generic form component for reusability.
Performance Optimization: GraphQL DataLoader batching to eliminate N+1 database query bottlenecks.

3. Functional Requirements
3.1 Authentication and Session
FR-1: System shall allow an employee to authenticate with email and password and shall issue a signed JWT on success. Passwords shall be stored only as bcrypt hashes.
FR-2: System shall attach the authenticated employee's identity, roles and resolved permission set to the request context on every GraphQL operation.
FR-3: System shall reject any operation whose required permission is absent from the caller's resolved permission set, returning an authorisation error without disclosing the existence or contents of the protected record.
FR-4: System shall expose a me query returning the current employee's profile, roles and permission keys, so that the client can render navigation and controls dynamically rather than from hard-coded role names.

3.2 Employee Management — employee
FR-5: System shall allow administrators to create an employee record capturing first name, last name, email and an initial password.
FR-6: System shall enforce email uniqueness and validate all inputs through class-validator rules before the service layer executes.
FR-7: System shall allow administrators to update and delete employee records. Deletion is a hard delete. Foreign keys from Booking and AuditLog to Employee use ON DELETE SET NULL; any UI displaying a requester, approver or audit actor whose employee record no longer exists shall display "Deleted user" in place of the name/email, so historical booking and audit data remain intact after an employee is removed.
FR-8: System shall display all employee records in a paginated list.
FR-9: System shall allow searching employees by first name, last name and email, and sorting by any displayed column.
FR-10: System shall display an individual employee's detail view including assigned roles and booking history.

3.3 Role and Permission Management — role, permission
FR-11: System shall allow administrators to create, read, update and delete roles.
FR-12: System shall display the full catalogue of permissions available in the system.
FR-13: System shall allow administrators to assign permissions to a role and remove permissions from a role.
FR-14: System shall allow administrators to assign roles to an employee and remove roles from an employee.
FR-15: System shall support an employee holding multiple roles, with the effective permission set computed as the union of all roles' permissions.
FR-16: System shall apply permission changes to the affected user's next request without requiring a redeployment.
FR-17: System shall prevent an administrator from removing the last remaining role that holds role:assign, so the system cannot be locked out of administration.
FR-89: Permission catalogue is: employee:read, employee:write, role:read, role:write, role:assign, permission:read, room:read, room:write, equipment:read, equipment:write, booking:create, booking:read:own, booking:read:all, booking:approve, booking:reject, booking:cancel:own, booking:cancel:any, audit:read, report:read.

3.4 Meeting Room Management — room
FR-18: System shall allow administrators to create a meeting room capturing name, location and capacity.
FR-19: System shall allow administrators to update a room and to deactivate it via the isActive flag.
FR-20: System shall exclude inactive rooms from booking selection while retaining them in historical booking records.
FR-21: System shall display all meeting rooms in a paginated list showing name, location, capacity and active state.
FR-22: System shall allow searching rooms by name and location, and filtering by capacity range and active state.
FR-23: System shall display an availability view for a selected room over a chosen date range, showing its approved and pending bookings.

3.5 Equipment Management — equipment
FR-24: System shall allow administrators to create an equipment record capturing name and quantity available.
FR-25: System shall allow administrators to update equipment and to deactivate it via the isActive flag.
FR-26: System shall exclude inactive equipment from booking selection while retaining it in historical booking records.
FR-27: System shall display all equipment in a paginated list showing name, quantity available and active state.
FR-28: System shall allow searching equipment by name and filtering by active state.
FR-29: System shall display, for a selected equipment item and time window, a single "remaining free quantity" figure, computed as quantityAvailable minus the sum of quantity committed to overlapping PENDING and APPROVED bookings for that item — the same calculation used by the booking engine's own availability check (FR-35), so the displayed figure and the enforced constraint never diverge.

3.6 Create Booking — booking:create
FR-30: System shall allow an authenticated employee to create a new booking request.
FR-31: System shall capture the following booking attributes:
Meeting room (optional if equipment is selected)
Equipment items and quantity per item (optional if a room is selected)
Start date and time
End date and time
Purpose
Number of attendees
FR-32: System shall reject a booking whose end time is not strictly after its start time, or whose start time is in the past.
FR-33: System shall reject a booking that overlaps in time with an existing PENDING or APPROVED booking for the same room. Two windows overlap when newStart < existingEnd and newEnd > existingStart; back-to-back bookings that merely touch at a boundary are permitted.
FR-34: System shall reject a booking whose number of attendees exceeds the capacity of the selected room.
FR-35: System shall reject a booking whose requested equipment quantity exceeds the quantity free across the requested time window. Availability is derived, not stored — computed as quantityAvailable minus the sum of quantities committed to all overlapping PENDING and APPROVED bookings for that item. There is no separate mutable "committed" counter; booking status and time window are the sole source of truth for availability.
FR-36: System shall persist a new booking with status PENDING and shall run the overlap, capacity and inventory checks inside a single database transaction with appropriate row locking, so that two concurrent requests for the last remaining slot cannot both succeed.
FR-37: System shall allow the booking owner to cancel a booking they created while it is PENDING, gated by the booking:cancel:own permission.
FR-38: System shall confirm successful submission of a booking request to the user via an on-screen prompt reporting the booking's identifier and its status. The booking's UUID id is used as its reference throughout the system; there is no separate human-readable reference column.

3.7 Booking List, Search and Export — booking:read:own, booking:read:all
FR-39: System shall display all booking records visible to the caller. A caller holding booking:read:all sees every booking in the system; a caller holding only booking:read:own sees only bookings they created. This scoping is applied in the repository layer, never in the client.
FR-40: System shall display, for each booking in the list, the requester name, resource, start time, end time, purpose, number of attendees, status and requested date/time. For processed bookings, the processed date/time and the approver/rejecter shall additionally be displayed. These are not stored as dedicated columns on Booking — they are derived by querying AuditLog for the booking's most recent APPROVED or REJECTED entry and reading its performedBy and createdAt.
FR-41: System shall allow searching bookings by requester, room name, equipment name, purpose and status.
FR-42: System shall allow filtering bookings by status and by a start/end date range.
FR-43: System shall support server-side pagination, sorting and filtering on the booking list, implemented through the generic data-table component so the same behaviour is available to every list screen in the application.

3.8 Booking Detail View
FR-45: System shall allow a permitted user to view the detailed information of an individual booking.
FR-46: System shall display complete booking details including requested date and time, and, where the booking has been processed, the processed date and time (derived from AuditLog per FR-40) and the rejection reason where applicable.
FR-47: System shall display the status history of the selected booking, sourced from the audit log, showing each transition with its old status, new status, actor and timestamp.
FR-48: System shall display a summary of the requesting employee, including name, email and their other recent bookings. Where the requesting employee's record has been deleted (FR-7), this section shall display "Deleted user" in place of the name/email.
FR-49: System shall display related resource information — for a room, its location and capacity and its other bookings in the same window; for equipment, its remaining availability during the booking window.

3.9 Approval Workflow — booking:approve, booking:reject
FR-50: System shall present managers with a queue of PENDING bookings awaiting a decision, ordered by requested date/time.
FR-51: System shall allow a manager to approve a PENDING booking, transitioning it to APPROVED.
FR-52: System shall re-validate time overlap, room capacity and equipment availability at the moment of approval inside a secure transaction, because the resource position may have changed since the request was submitted. If re-validation fails the approval shall be refused and the reason surfaced to the manager.
FR-53: Because availability is derived (FR-35), no separate inventory counter needs to be decremented — the approval itself, recorded within the transaction, is what causes the booking to be counted in subsequent availability calculations.
FR-54: System shall allow a manager to reject a PENDING booking, requiring a rejection reason of at least a configured minimum length, and shall persist that reason on the booking record.
FR-55: System shall refuse any approval or rejection against a booking that is not currently PENDING, returning a clear domain error.
FR-56: System shall prevent a manager from approving or rejecting a booking they themselves created.

3.10 Notifications — real-time and email
FR-57: System shall create a notification record addressed to the requesting employee whenever their booking is approved, rejected or cancelled by another party.
FR-58: System shall create a notification addressed to the approving managers whenever a new booking enters the PENDING state.
FR-59: System shall deliver notifications to connected clients in real time over a plain WebSocket gateway (not GraphQL subscriptions — GraphQL is used for queries and mutations only), and shall display an unread count that updates without a page refresh.
FR-60: System shall allow a user to mark an individual notification, or all notifications, as read.
FR-61: System shall dispatch a corresponding transactional email via SendGrid for approval, rejection and upcoming-booking reminder events. Email dispatch failures shall be logged and retried, and shall never roll back the underlying booking transaction.
FR-90: The WebSocket gateway shall authenticate connections via JWT on handshake, reusing the existing auth and permission-resolution logic. WebSocket emission and email dispatch (FR-61) shall both occur only after the enclosing database transaction commits, never from within it.

3.11 Audit Trail — audit:read
FR-62: System shall automatically record an audit entry for every booking lifecycle action — creation, approval, rejection, cancellation and automated completion — capturing the booking, the action, the old status, the new status, the actor and the timestamp.
FR-63: System shall write the audit entry within the same transaction as the state change it describes.
FR-64: System shall treat audit records as immutable; no interface shall permit their update or deletion.
FR-65: System shall allow administrators to view and search the global audit log by booking, actor, action, status and date range, with server-side pagination.

3.12 Reporting — report:read
FR-66: System shall provide a Most Booked Rooms report ranking rooms by booking count over a selected date range.
FR-67: System shall provide a Bookings per Employee report showing booking counts by employee, broken down by final status.
FR-68: System shall provide an Equipment Usage report showing total quantity-hours committed per equipment item over a selected date range.
FR-69: System shall provide a Monthly Booking Statistics report showing bookings created, approved, rejected and cancelled per month.
FR-70: System shall implement all reporting reads through the ORM query builder with aggregation performed in the database, returning only aggregated rows to the application layer.

3.13 Scheduled Background Jobs
FR-72: System shall run a scheduled job that transitions APPROVED bookings whose end time has elapsed to COMPLETED, writing an audit entry attributed to a reserved system Employee record (a fixed, seeded account, e.g. system@internal) as the actor.
FR-73: Because availability is derived (FR-35), completed or cancelled bookings are automatically excluded from future availability calculations once their status changes — no separate inventory-release step is required.
FR-74: System shall run a scheduled job that sends reminder notifications for bookings starting within a configured lead time.
FR-75: System shall make every scheduled job idempotent. For reminders specifically, idempotency is enforced by checking whether a Notification of type REMINDER already exists for the booking before creating a new one, rather than a dedicated timestamp column. Other jobs must similarly ensure a re-run over the same window produces no duplicate state changes or audit entries.

4. Non-Functional Requirements
NFR-1 — N+1 elimination: All parent-to-child GraphQL field resolution (booking → employee, booking → room, booking → equipment, role → permissions) shall be served through per-request DataLoader instances that batch and cache lookups. No list query shall issue a number of database round-trips proportional to the number of rows returned.
NFR-2 — Pagination everywhere: No resolver shall return an unbounded collection. Every list endpoint shall accept page, page size, sort and filter arguments and return a total count alongside the page.
NFR-3 — Transactional integrity: Booking creation, approval, rejection and cancellation shall each execute within a single database transaction. Partial writes shall not be observable.
NFR-4 — Performance: A booking list page of 25 rows with filters applied shall return in under 500 ms at the 95th percentile for a dataset of 100,000 bookings. Supporting indexes are required on booking(start_time, end_time), booking(status), booking(employee_id) and the room/equipment foreign keys.
NFR-5 — Security: Passwords are bcrypt-hashed and never returned by any resolver. JWTs are signed, expiring, and validated on every request. Permission checks are enforced server-side; client-side hiding of controls is a usability affordance only and is never the enforcement point.
NFR-6 — Input validation: All mutation inputs pass class-validator rules before reaching the service layer, and validation failures return field-level errors the client can render inline.
NFR-7 — Reusability: List screens shall be built on a single generic data-table component supporting server-side pagination, search, sort, filter and dynamic column definitions. Forms shall be built on a single generic form component driven by a field schema.
NFR-8 — Auditability: Every state transition is attributable to an actor and a timestamp, with no gaps in the history of a booking.

5. System Architecture
5.1 Technology stack
Layer	Technology
Frontend	React, TypeScript, CSS, Apollo GraphQL client
Backend	Node.js, TypeScript, TypeGraphQL, WebSockets
Database & ORM	PostgreSQL, TypeORM
Security & automation	JWT, bcrypt, class-validator, node-cron, SendGrid

Frontend component props use TypeScript interfaces; GraphQL operations use generated types (e.g. via graphql-code-generator) rather than JSDoc/PropTypes.

5.2 Architectural pattern

The application follows a clean-architecture model that separates concerns across layers.

Frontend — feature-based module organisation. Each feature directory encapsulates its own components, hooks, GraphQL documents and pages, so a feature can be understood and changed in isolation.
Backend — layered architecture: Resolver → Service → Repository → Database Resolvers handle transport and authorisation only. Services own business rules and transaction boundaries. Repositories own query construction. No layer reaches past its immediate neighbour. Real-time delivery (FR-59) is handled by a separate WebSocket gateway layer, invoked from services after transaction commit — it is not part of the GraphQL schema.

5.3 Request lifecycle
Client request — the React client issues a GraphQL query or mutation through Apollo Client.
Authentication and authorisation — middleware validates the incoming JWT and resolves the user's dynamic permission set into the request context; the resolver's permission guard then admits or rejects the operation.
Validation — inputs pass through class-validator rules before reaching the service layer.
Execution — the service layer applies business rules and opens a transaction where the operation mutates state.
Database interaction — TypeORM executes queries and transactions, maintaining integrity across operations such as booking approval.
Side effects — audit entries are written in-transaction; WebSocket notifications and emails are dispatched after commit.

5.4 Project scaffold
The initial project structure excludes Docker and CI/CD tooling entirely — no Dockerfile, docker-compose, or .github/workflows. The scaffold is local-dev-only for now: environment files, package scripts, and README run instructions. Deployment tooling is out of scope until the application is functionally complete.

6. Data Model
Entity	Fields
Employee	id, firstName, lastName, email, password, createdAt, updatedAt
Role	id, roleName
UserRole	id, employeeId, roleId
Permission	id, permissionName
RolePermission	id, roleId, permissionId
MeetingRoom	id, name, location, capacity, isActive, createdAt, updatedAt
Equipment	id, name, quantityAvailable, isActive, createdAt, updatedAt
Booking	id, employeeId, roomId (nullable), startTime, endTime, purpose, rejectionReason, numberOfAttendees, status, createdAt, updatedAt
BookingEquipment	id, bookingId, equipmentId, quantity
AuditLog	id, bookingId, action, oldStatus, newStatus, performedBy, createdAt
Notification	id, recipientId, bookingId, type, title, message, isRead, createdAt

Relationships

Employee ↔ Role is many-to-many through UserRole.
Role ↔ Permission is many-to-many through RolePermission.
Booking belongs to one Employee (the requester) and optionally to one MeetingRoom.
Booking ↔ Equipment is many-to-many through BookingEquipment, which carries a quantity attribute.
AuditLog and Notification each belong to one Booking and reference one Employee.

Notes on deliberate omissions (see §3 for the reasoning behind each):

No Employee.deletedAt — deletion is a hard delete with ON DELETE SET NULL on referencing foreign keys (FR-7).
No Booking.processedById / processedAt — derived from AuditLog (FR-40).
No Booking.reminderSentAt — reminder idempotency checked via existing Notification records (FR-75).
No Booking.reference — the UUID id serves as the reference (FR-38).
AuditLog.performedBy is nullable at the schema level to support ON DELETE SET NULL when the referenced employee is deleted. The application always supplies a value on insert (the real actor, or the system employee for automated actions). Where a historical actor's record has since been deleted, the UI displays "Deleted user," consistent with the fallback used for booking requesters (FR-48).

7. Configuration
The following values are environment-configured, with defaults for local development:

REJECTION_REASON_MIN_LENGTH=10
REMINDER_LEAD_TIME_MINUTES=60
JWT_EXPIRY=1h