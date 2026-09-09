/**
 * GENERATED FILE — do not edit by hand.
 * Regenerate with: node scripts/generate/generateModuleOwnership.js
 *
 * Ownership data only: maps an endpoint path to its owning Swagger tag and the team a
 * defect should be routed to. Contains no test logic — every test is hand-written under
 * tests/<tag>/.
 *
 * Covers 297 active endpoints across 27 tags.
 */

export interface ModuleOwnership {
  module: string;
  team: string;
}

export const MODULE_BY_PATH: Record<string, ModuleOwnership> = {
  "/v2/voice/translate": {
    "module": "Integration - Voice / Speech-to-Text",
    "team": "AI Integration"
  },
  "/v2/signupLogin/userLogout": {
    "module": "Authentication V2",
    "team": "Identity & Access"
  },
  "/v2/signupLogin/userLogin": {
    "module": "Authentication V2",
    "team": "Identity & Access"
  },
  "/v2/signupLogin/signup": {
    "module": "Authentication V2",
    "team": "Identity & Access"
  },
  "/v2/signupLogin/setAccessCode": {
    "module": "Authentication V2",
    "team": "Identity & Access"
  },
  "/v2/signupLogin/kpostIdExist": {
    "module": "Authentication V2",
    "team": "Identity & Access"
  },
  "/v2/signupLogin/kpostIDsuggestionList": {
    "module": "Authentication V2",
    "team": "Identity & Access"
  },
  "/v2/signupLogin/getLoginHistory": {
    "module": "Authentication V2",
    "team": "Identity & Access"
  },
  "/v2/signupLogin/generateJWTokens": {
    "module": "Authentication V2",
    "team": "Identity & Access"
  },
  "/v2/signupLogin/fetchUserDetails": {
    "module": "Authentication V2",
    "team": "Identity & Access"
  },
  "/v2/signupLogin/fetchPersonalUserDetails": {
    "module": "Authentication V2",
    "team": "Identity & Access"
  },
  "/v2/signupLogin/adminRegistration": {
    "module": "Authentication V2",
    "team": "Identity & Access"
  },
  "/v2/profile/uploadProfileAttachments": {
    "module": "User Profile V2",
    "team": "User Profile"
  },
  "/v2/profile/uploadImageToS3": {
    "module": "User Profile V2",
    "team": "User Profile"
  },
  "/v2/profile/uploadCoverImage": {
    "module": "User Profile V2",
    "team": "User Profile"
  },
  "/v2/profile/updateSignatureImage": {
    "module": "User Profile V2",
    "team": "User Profile"
  },
  "/v2/profile/updateProfileImage": {
    "module": "User Profile V2",
    "team": "User Profile"
  },
  "/v2/profile/updatePrivacySettingDetails": {
    "module": "User Profile V2",
    "team": "User Profile"
  },
  "/v2/profile/updateDeviceAsSecondary": {
    "module": "User Profile V2",
    "team": "User Profile"
  },
  "/v2/profile/updateDeviceAsPrimary": {
    "module": "User Profile V2",
    "team": "User Profile"
  },
  "/v2/profile/updateDesignation": {
    "module": "User Profile V2",
    "team": "User Profile"
  },
  "/v2/profile/updateContactInformation": {
    "module": "User Profile V2",
    "team": "User Profile"
  },
  "/v2/profile/updateBasicInformation": {
    "module": "User Profile V2",
    "team": "User Profile"
  },
  "/v2/profile/updateAboutYourself": {
    "module": "User Profile V2",
    "team": "User Profile"
  },
  "/v2/profile/shareUserDetails": {
    "module": "User Profile V2",
    "team": "User Profile"
  },
  "/v2/profile/setProfilePrivacy": {
    "module": "User Profile V2",
    "team": "User Profile"
  },
  "/v2/profile/setDeviceAsSecondary": {
    "module": "User Profile V2",
    "team": "User Profile"
  },
  "/v2/profile/setDeviceAsPrimary": {
    "module": "User Profile V2",
    "team": "User Profile"
  },
  "/v2/profile/saveOrUpdateUniversityDetails": {
    "module": "User Profile V2",
    "team": "User Profile"
  },
  "/v2/profile/saveOrUpdateSchoolDetails": {
    "module": "User Profile V2",
    "team": "User Profile"
  },
  "/v2/profile/saveOrUpdateOtherActivity": {
    "module": "User Profile V2",
    "team": "User Profile"
  },
  "/v2/profile/saveOrUpdateExperienceDetails": {
    "module": "User Profile V2",
    "team": "User Profile"
  },
  "/v2/profile/saveOrUpdateCollegeDetails": {
    "module": "User Profile V2",
    "team": "User Profile"
  },
  "/v2/profile/kmailPasswordPatchWork": {
    "module": "User Profile V2",
    "team": "User Profile"
  },
  "/v2/profile/getlanguages": {
    "module": "User Profile V2",
    "team": "User Profile"
  },
  "/v2/profile/getUserProfileUsingKpostID": {
    "module": "User Profile V2",
    "team": "User Profile"
  },
  "/v2/profile/getUserBasicDetailsUsingKpostID": {
    "module": "User Profile V2",
    "team": "User Profile"
  },
  "/v2/profile/getDigitalCard": {
    "module": "User Profile V2",
    "team": "User Profile"
  },
  "/v2/profile/getDesignationOrProfession": {
    "module": "User Profile V2",
    "team": "User Profile"
  },
  "/v2/profile/deleteUniversityDetail": {
    "module": "User Profile V2",
    "team": "User Profile"
  },
  "/v2/profile/deleteSchoolDetail": {
    "module": "User Profile V2",
    "team": "User Profile"
  },
  "/v2/profile/deleteOtherActivity": {
    "module": "User Profile V2",
    "team": "User Profile"
  },
  "/v2/profile/deleteExperienceDetail": {
    "module": "User Profile V2",
    "team": "User Profile"
  },
  "/v2/profile/deleteCollegeDetail": {
    "module": "User Profile V2",
    "team": "User Profile"
  },
  "/v2/profile/deactivateAccount": {
    "module": "User Profile V2",
    "team": "User Profile"
  },
  "/v2/profile/convertBase64ToImage": {
    "module": "User Profile V2",
    "team": "User Profile"
  },
  "/v2/profile/changePassword": {
    "module": "User Profile V2",
    "team": "User Profile"
  },
  "/v2/profile/changeOrForgotAccessCode": {
    "module": "User Profile V2",
    "team": "User Profile"
  },
  "/v2/profile/autoSearchWithName": {
    "module": "User Profile V2",
    "team": "User Profile"
  },
  "/v2/profile/advancedSearch": {
    "module": "User Profile V2",
    "team": "User Profile"
  },
  "/v2/knews/updateKnewsSettings": {
    "module": "Knews",
    "team": "Knews"
  },
  "/v2/knews/getSubCategoriesByCategoryId": {
    "module": "Knews",
    "team": "Knews"
  },
  "/v2/knews/getPublicationByLanguageId": {
    "module": "Knews",
    "team": "Knews"
  },
  "/v2/katchup/uploadMultipartFiles/": {
    "module": "Katchup Messaging V2",
    "team": "Messaging"
  },
  "/v2/katchup/sendMessage": {
    "module": "Katchup Messaging V2",
    "team": "Messaging"
  },
  "/v2/katchup/sendMessageForForwardSelectedAttachment": {
    "module": "Katchup Messaging V2",
    "team": "Messaging"
  },
  "/v2/katchup/sendKatchupMsgMultiPart/": {
    "module": "Katchup Messaging V2",
    "team": "Messaging"
  },
  "/v2/katchup/sendBulkKatchupMsg": {
    "module": "Katchup Messaging V2",
    "team": "Messaging"
  },
  "/v2/katchup/sendBulkKatchupMsgMultiPart/": {
    "module": "Katchup Messaging V2",
    "team": "Messaging"
  },
  "/v2/katchup/searchKatchUpMessage": {
    "module": "Katchup Messaging V2",
    "team": "Messaging"
  },
  "/v2/katchup/searchKatchUpMessageSubject": {
    "module": "Katchup Messaging V2",
    "team": "Messaging"
  },
  "/v2/katchup/saveKatchupMessages": {
    "module": "Katchup Messaging V2",
    "team": "Messaging"
  },
  "/v2/katchup/reportAbuse": {
    "module": "Katchup Messaging V2",
    "team": "Messaging"
  },
  "/v2/katchup/recallMessage": {
    "module": "Katchup Messaging V2",
    "team": "Messaging"
  },
  "/v2/katchup/patchWorkForGroup": {
    "module": "Katchup Messaging V2",
    "team": "Messaging"
  },
  "/v2/katchup/messageCountBetweenSenderAndReceiver": {
    "module": "Katchup Messaging V2",
    "team": "Messaging"
  },
  "/v2/katchup/markOrUnmarkImportantMessage": {
    "module": "Katchup Messaging V2",
    "team": "Messaging"
  },
  "/v2/katchup/katchupSearch": {
    "module": "Katchup Messaging V2",
    "team": "Messaging"
  },
  "/v2/katchup/katchupMessagesForSelectedContactID": {
    "module": "Katchup Messaging V2",
    "team": "Messaging"
  },
  "/v2/katchup/getSharedMessageInfo": {
    "module": "Katchup Messaging V2",
    "team": "Messaging"
  },
  "/v2/katchup/getReferenceMessagesDetails": {
    "module": "Katchup Messaging V2",
    "team": "Messaging"
  },
  "/v2/katchup/getReferenceMSGDetails": {
    "module": "Katchup Messaging V2",
    "team": "Messaging"
  },
  "/v2/katchup/getReadStatusGroupMessage": {
    "module": "Katchup Messaging V2",
    "team": "Messaging"
  },
  "/v2/katchup/getMessagesByReferenceMessageList": {
    "module": "Katchup Messaging V2",
    "team": "Messaging"
  },
  "/v2/katchup/getBulkMessageInfo": {
    "module": "Katchup Messaging V2",
    "team": "Messaging"
  },
  "/v2/katchup/generateThumbnailUsingUUID": {
    "module": "Katchup Messaging V2",
    "team": "Messaging"
  },
  "/v2/katchup/forwardMessageBacktrackByMsgID": {
    "module": "Katchup Messaging V2",
    "team": "Messaging"
  },
  "/v2/katchup/forwardKatchupMultipleMsgs": {
    "module": "Katchup Messaging V2",
    "team": "Messaging"
  },
  "/v2/katchup/forwardKatchupMessage": {
    "module": "Katchup Messaging V2",
    "team": "Messaging"
  },
  "/v2/katchup/forwardKatchupMessageNew": {
    "module": "Katchup Messaging V2",
    "team": "Messaging"
  },
  "/v2/katchup/filterKatchUpMessage": {
    "module": "Katchup Messaging V2",
    "team": "Messaging"
  },
  "/v2/katchup/deleteKatchUpMessage": {
    "module": "Katchup Messaging V2",
    "team": "Messaging"
  },
  "/v2/katchup/changeCaption": {
    "module": "Katchup Messaging V2",
    "team": "Messaging"
  },
  "/v2/kall/updateSenderAndReceiverKallStatus": {
    "module": "Kall (Voice/Video) V2 - current",
    "team": "Realtime Communications"
  },
  "/v2/kall/updateKallStatus": {
    "module": "Kall (Voice/Video) V2 - current",
    "team": "Realtime Communications"
  },
  "/v2/kall/scheduledRepeatKall": {
    "module": "Kall (Voice/Video) V2 - current",
    "team": "Realtime Communications"
  },
  "/v2/kall/scheduledKall": {
    "module": "Kall (Voice/Video) V2 - current",
    "team": "Realtime Communications"
  },
  "/v2/kall/reScheduleKall": {
    "module": "Kall (Voice/Video) V2 - current",
    "team": "Realtime Communications"
  },
  "/v2/kall/modifyKallMembers": {
    "module": "Kall (Voice/Video) V2 - current",
    "team": "Realtime Communications"
  },
  "/v2/kall/kallInfo": {
    "module": "Kall (Voice/Video) V2 - current",
    "team": "Realtime Communications"
  },
  "/v2/kall/kallDashboard": {
    "module": "Kall (Voice/Video) V2 - current",
    "team": "Realtime Communications"
  },
  "/v2/kall/joinScheduleKall": {
    "module": "Kall (Voice/Video) V2 - current",
    "team": "Realtime Communications"
  },
  "/v2/kall/initiateKall": {
    "module": "Kall (Voice/Video) V2 - current",
    "team": "Realtime Communications"
  },
  "/v2/kall/getKallStatus": {
    "module": "Kall (Voice/Video) V2 - current",
    "team": "Realtime Communications"
  },
  "/v2/kall/getKallStatusUsingKallID": {
    "module": "Kall (Voice/Video) V2 - current",
    "team": "Realtime Communications"
  },
  "/v2/kall/fetchScheduledRepeatKall": {
    "module": "Kall (Voice/Video) V2 - current",
    "team": "Realtime Communications"
  },
  "/v2/kall/endKoolKall": {
    "module": "Kall (Voice/Video) V2 - current",
    "team": "Realtime Communications"
  },
  "/v2/kall/endIndividualKall": {
    "module": "Kall (Voice/Video) V2 - current",
    "team": "Realtime Communications"
  },
  "/v2/kall/contactInfo": {
    "module": "Kall (Voice/Video) V2 - current",
    "team": "Realtime Communications"
  },
  "/v2/kall/clearKallBykallIds": {
    "module": "Kall (Voice/Video) V2 - current",
    "team": "Realtime Communications"
  },
  "/v2/kall/addMembersToKall": {
    "module": "Kall (Voice/Video) V2 - current",
    "team": "Realtime Communications"
  },
  "/v2/group/updateGroupProfileImage": {
    "module": "Groups V2",
    "team": "Groups"
  },
  "/v2/group/removeGroupProfileImage": {
    "module": "Groups V2",
    "team": "Groups"
  },
  "/v2/group/removeGroupMember": {
    "module": "Groups V2",
    "team": "Groups"
  },
  "/v2/group/leaveFromGroup": {
    "module": "Groups V2",
    "team": "Groups"
  },
  "/v2/group/editGroupName": {
    "module": "Groups V2",
    "team": "Groups"
  },
  "/v2/group/deleteGroup": {
    "module": "Groups V2",
    "team": "Groups"
  },
  "/v2/group/createUserGroup": {
    "module": "Groups V2",
    "team": "Groups"
  },
  "/v2/group/addUserToGroup": {
    "module": "Groups V2",
    "team": "Groups"
  },
  "/v2/group/addOrRemoveAdminAccess": {
    "module": "Groups V2",
    "team": "Groups"
  },
  "/v2/dashboard/katchupDashboardMsg": {
    "module": "Dashboard V2",
    "team": "Dashboard"
  },
  "/v2/dashboard/kallDashboard": {
    "module": "Dashboard V2",
    "team": "Dashboard"
  },
  "/v2/dashboard/homeDashboardNewMsgs": {
    "module": "Dashboard V2",
    "team": "Dashboard"
  },
  "/v2/dashboard/homeDashboardMsgs": {
    "module": "Dashboard V2",
    "team": "Dashboard"
  },
  "/v2/dashboard/getKmailDashboardMsg": {
    "module": "Dashboard V2",
    "team": "Dashboard"
  },
  "/v2/contacts/updateInviteStatus": {
    "module": "Contacts Directory V2",
    "team": "Contacts"
  },
  "/v2/contacts/myUnknownKatchupContacts": {
    "module": "Contacts Directory V2",
    "team": "Contacts"
  },
  "/v2/contacts/myUnknownGroups": {
    "module": "Contacts Directory V2",
    "team": "Contacts"
  },
  "/v2/contacts/myGroups": {
    "module": "Contacts Directory V2",
    "team": "Contacts"
  },
  "/v2/contacts/myContacts": {
    "module": "Contacts Directory V2",
    "team": "Contacts"
  },
  "/v2/contacts/importPhoneContacts": {
    "module": "Contacts Directory V2",
    "team": "Contacts"
  },
  "/v2/contacts/globalSearch": {
    "module": "Contacts Directory V2",
    "team": "Contacts"
  },
  "/v2/contacts/getSearchDetails": {
    "module": "Contacts Directory V2",
    "team": "Contacts"
  },
  "/v2/contacts/deleteContact": {
    "module": "Contacts Directory V2",
    "team": "Contacts"
  },
  "/v2/contacts/blockOrUnBlockMultipleContact": {
    "module": "Contacts Directory V2",
    "team": "Contacts"
  },
  "/v2/contacts/blockOrUnBlockContact": {
    "module": "Contacts Directory V2",
    "team": "Contacts"
  },
  "/v2/contacts/addMultipleContact": {
    "module": "Contacts Directory V2",
    "team": "Contacts"
  },
  "/v2/contacts/addContact": {
    "module": "Contacts Directory V2",
    "team": "Contacts"
  },
  "/v2/contacts/addContactReference": {
    "module": "Contacts Directory V2",
    "team": "Contacts"
  },
  "/v2/common/validateOTP": {
    "module": "Common Reference Data & Utilities V2",
    "team": "Platform Common Services"
  },
  "/v2/common/validateMailOTP": {
    "module": "Common Reference Data & Utilities V2",
    "team": "Platform Common Services"
  },
  "/v2/common/updateFlutterAppVersion": {
    "module": "Common Reference Data & Utilities V2",
    "team": "Platform Common Services"
  },
  "/v2/common/updateCompanyLogo": {
    "module": "Common Reference Data & Utilities V2",
    "team": "Platform Common Services"
  },
  "/v2/common/uniqueNameExist": {
    "module": "Common Reference Data & Utilities V2",
    "team": "Platform Common Services"
  },
  "/v2/common/sendOTPtoMail": {
    "module": "Common Reference Data & Utilities V2",
    "team": "Platform Common Services"
  },
  "/v2/common/sendOTP": {
    "module": "Common Reference Data & Utilities V2",
    "team": "Platform Common Services"
  },
  "/v2/common/sendMessage": {
    "module": "Common Reference Data & Utilities V2",
    "team": "Platform Common Services"
  },
  "/v2/common/saveEnquiryDetails": {
    "module": "Common Reference Data & Utilities V2",
    "team": "Platform Common Services"
  },
  "/v2/common/postalPinCode": {
    "module": "Common Reference Data & Utilities V2",
    "team": "Platform Common Services"
  },
  "/v2/common/pinCode": {
    "module": "Common Reference Data & Utilities V2",
    "team": "Platform Common Services"
  },
  "/v2/common/mobileNoExist": {
    "module": "Common Reference Data & Utilities V2",
    "team": "Platform Common Services"
  },
  "/v2/common/mobileNoExistInsideCompany": {
    "module": "Common Reference Data & Utilities V2",
    "team": "Platform Common Services"
  },
  "/v2/common/languages": {
    "module": "Common Reference Data & Utilities V2",
    "team": "Platform Common Services"
  },
  "/v2/common/isCompanyNameExist": {
    "module": "Common Reference Data & Utilities V2",
    "team": "Platform Common Services"
  },
  "/v2/common/getUserDetailsByMobNo": {
    "module": "Common Reference Data & Utilities V2",
    "team": "Platform Common Services"
  },
  "/v2/common/getTotalCountByDate": {
    "module": "Common Reference Data & Utilities V2",
    "team": "Platform Common Services"
  },
  "/v2/common/getKpostIdUsingModule": {
    "module": "Common Reference Data & Utilities V2",
    "team": "Platform Common Services"
  },
  "/v2/common/getDesignation": {
    "module": "Common Reference Data & Utilities V2",
    "team": "Platform Common Services"
  },
  "/v2/common/getDesignationByProfessionId": {
    "module": "Common Reference Data & Utilities V2",
    "team": "Platform Common Services"
  },
  "/v2/common/getCompanyDetails": {
    "module": "Common Reference Data & Utilities V2",
    "team": "Platform Common Services"
  },
  "/v2/common/getCompanyDetailsByMobileNoAndproductId": {
    "module": "Common Reference Data & Utilities V2",
    "team": "Platform Common Services"
  },
  "/v2/common/getCompanyDetailsByAdmin": {
    "module": "Common Reference Data & Utilities V2",
    "team": "Platform Common Services"
  },
  "/v2/common/getCitiesByRegionId": {
    "module": "Common Reference Data & Utilities V2",
    "team": "Platform Common Services"
  },
  "/v2/common/generateDomainAndUniqueName": {
    "module": "Common Reference Data & Utilities V2",
    "team": "Platform Common Services"
  },
  "/v2/common/forgotPasswordUpdate": {
    "module": "Common Reference Data & Utilities V2",
    "team": "Platform Common Services"
  },
  "/v2/common/forgotPasswordOTPOrSentKpostIDSms": {
    "module": "Common Reference Data & Utilities V2",
    "team": "Platform Common Services"
  },
  "/v2/common/domain": {
    "module": "Common Reference Data & Utilities V2",
    "team": "Platform Common Services"
  },
  "/v2/common/country": {
    "module": "Common Reference Data & Utilities V2",
    "team": "Platform Common Services"
  },
  "/v2/aws/katchup/generate-presigned-url": {
    "module": "Integration - AWS S3 Pre-signed URLs",
    "team": "Platform Infrastructure"
  },
  "/v2/aws/generate-presigned-url": {
    "module": "Integration - AWS S3 Pre-signed URLs",
    "team": "Platform Infrastructure"
  },
  "/v2/aws/checkAttachmentS3": {
    "module": "Integration - AWS S3 Pre-signed URLs",
    "team": "Platform Infrastructure"
  },
  "/taWallet/sendCommunicationMessage": {
    "module": "Integration - TA Wallet Callback",
    "team": "Payments Integration"
  },
  "/taWallet/paymentRequest": {
    "module": "TA Wallet Payments",
    "team": "Payments Integration"
  },
  "/taWallet/paymentRequest1": {
    "module": "TA Wallet Payments",
    "team": "Payments Integration"
  },
  "/taWallet/fetchTransactionDetailsByOrderId": {
    "module": "TA Wallet Payments",
    "team": "Payments Integration"
  },
  "/taWallet/createHash": {
    "module": "TA Wallet Payments",
    "team": "Payments Integration"
  },
  "/signupLoginForMediumAndLarge/signup": {
    "module": "Authentication - Medium & Large Enterprise",
    "team": "Identity & Access"
  },
  "/signupLoginForMediumAndLarge/adminUserLogin": {
    "module": "Authentication - Medium & Large Enterprise",
    "team": "Identity & Access"
  },
  "/signupLoginForMediumAndLarge/addingUserByAdmin": {
    "module": "Authentication - Medium & Large Enterprise",
    "team": "Identity & Access"
  },
  "/redbus/tripdetailsV2/": {
    "module": "Integration - RedBus Bus Booking",
    "team": "Travel Integration"
  },
  "/redbus/tripdetails/": {
    "module": "Integration - RedBus Bus Booking",
    "team": "Travel Integration"
  },
  "/redbus/ticketdetails/": {
    "module": "Integration - RedBus Bus Booking",
    "team": "Travel Integration"
  },
  "/redbus/seatLayout/": {
    "module": "Integration - RedBus Bus Booking",
    "team": "Travel Integration"
  },
  "/redbus/getUpdatedFare/": {
    "module": "Integration - RedBus Bus Booking",
    "team": "Travel Integration"
  },
  "/redbus/destinations/": {
    "module": "Integration - RedBus Bus Booking",
    "team": "Travel Integration"
  },
  "/redbus/cancelticket/": {
    "module": "Integration - RedBus Bus Booking",
    "team": "Travel Integration"
  },
  "/redbus/bookticket": {
    "module": "Integration - RedBus Bus Booking",
    "team": "Travel Integration"
  },
  "/redbus/blockTicket/{kPostId}": {
    "module": "Integration - RedBus Bus Booking",
    "team": "Travel Integration"
  },
  "/redbus/availabletrips/": {
    "module": "Integration - RedBus Bus Booking",
    "team": "Travel Integration"
  },
  "/razorPay/validateAndUpdateTransactionDetails": {
    "module": "Integration - RazorPay Payments",
    "team": "Payments Integration"
  },
  "/razorPay/generateOrderId": {
    "module": "Integration - RazorPay Payments",
    "team": "Payments Integration"
  },
  "/metaDee/aiMessage": {
    "module": "Integration - MetaDee AI",
    "team": "AI Integration"
  },
  "/kword/update": {
    "module": "KWord Documents",
    "team": "Documents"
  },
  "/kword/share": {
    "module": "KWord Documents",
    "team": "Documents"
  },
  "/kword/saveContent": {
    "module": "KWord Documents",
    "team": "Documents"
  },
  "/kword/isConvertToKad": {
    "module": "KWord Documents",
    "team": "Documents"
  },
  "/kword/delete": {
    "module": "KWord Documents",
    "team": "Documents"
  },
  "/kword/deleteHeading": {
    "module": "KWord Documents",
    "team": "Documents"
  },
  "/kword/create": {
    "module": "KWord Documents",
    "team": "Documents"
  },
  "/kpresentation/savePresentation": {
    "module": "KPresentation",
    "team": "Documents"
  },
  "/kpresentation/create": {
    "module": "KPresentation",
    "team": "Documents"
  },
  "/generalSetting/kmailNotification": {
    "module": "General Settings",
    "team": "Platform Common Services"
  },
  "/generalSetting/katchupNotification": {
    "module": "General Settings",
    "team": "Platform Common Services"
  },
  "/generalSetting/kallNotification": {
    "module": "General Settings",
    "team": "Platform Common Services"
  },
  "/generalSetting/fontSetting": {
    "module": "General Settings",
    "team": "Platform Common Services"
  },
  "/generalSetting/changeTheme": {
    "module": "General Settings",
    "team": "Platform Common Services"
  },
  "/dairySchedule/updateScheduleRemarks": {
    "module": "Kdiary - Schedules, Events & Reports",
    "team": "Kdiary"
  },
  "/dairySchedule/updateEvent": {
    "module": "Kdiary - Schedules, Events & Reports",
    "team": "Kdiary"
  },
  "/dairySchedule/saveReport": {
    "module": "Kdiary - Schedules, Events & Reports",
    "team": "Kdiary"
  },
  "/dairySchedule/getEventSelectedDate": {
    "module": "Kdiary - Schedules, Events & Reports",
    "team": "Kdiary"
  },
  "/dairySchedule/getEventDate": {
    "module": "Kdiary - Schedules, Events & Reports",
    "team": "Kdiary"
  },
  "/dairySchedule/editScheduleEvent": {
    "module": "Kdiary - Schedules, Events & Reports",
    "team": "Kdiary"
  },
  "/dairySchedule/editReport": {
    "module": "Kdiary - Schedules, Events & Reports",
    "team": "Kdiary"
  },
  "/dairySchedule/deleteReport": {
    "module": "Kdiary - Schedules, Events & Reports",
    "team": "Kdiary"
  },
  "/dairySchedule/deleteEvent": {
    "module": "Kdiary - Schedules, Events & Reports",
    "team": "Kdiary"
  },
  "/dairySchedule/createSchedule": {
    "module": "Kdiary - Schedules, Events & Reports",
    "team": "Kdiary"
  },
  "/dairySchedule/createEvent": {
    "module": "Kdiary - Schedules, Events & Reports",
    "team": "Kdiary"
  },
  "/dairySchedule/addparticipants": {
    "module": "Kdiary - Schedules, Events & Reports",
    "team": "Kdiary"
  },
  "/ai/messageAssist": {
    "module": "Integration - AI Assistant",
    "team": "AI Integration"
  },
  "/ai/messageAssistStream": {
    "module": "Integration - AI Assistant",
    "team": "AI Integration"
  },
  "/ai/chatResponse": {
    "module": "Integration - AI Assistant",
    "team": "AI Integration"
  },
  "/admin/updateRole": {
    "module": "Company Administration",
    "team": "Company Administration"
  },
  "/admin/updateCompanyDetails": {
    "module": "Company Administration",
    "team": "Company Administration"
  },
  "/admin/updateBankAccountDetails": {
    "module": "Company Administration",
    "team": "Company Administration"
  },
  "/admin/terminateUser": {
    "module": "Company Administration",
    "team": "Company Administration"
  },
  "/admin/resetPassword": {
    "module": "Company Administration",
    "team": "Company Administration"
  },
  "/admin/removeCompanyLogo": {
    "module": "Company Administration",
    "team": "Company Administration"
  },
  "/admin/holdOrRelease": {
    "module": "Company Administration",
    "team": "Company Administration"
  },
  "/admin/displayNameSuggestion": {
    "module": "Company Administration",
    "team": "Company Administration"
  },
  "/admin/createOrRemoveBackupAdmin": {
    "module": "Company Administration",
    "team": "Company Administration"
  },
  "/admin/createKpostIDAndDesignationSuggestion": {
    "module": "Company Administration",
    "team": "Company Administration"
  },
  "/admin/addingUserForReallocateByAdmin": {
    "module": "Company Administration",
    "team": "Company Administration"
  },
  "/admin/addingUserByAdmin": {
    "module": "Company Administration",
    "team": "Company Administration"
  },
  "/": {
    "module": "kpost-webservice-application",
    "team": "Platform Infrastructure"
  },
  "/v2/signupLogin/userLogoutFromAllDevices": {
    "module": "Authentication V2",
    "team": "Identity & Access"
  },
  "/v2/signupLogin/getActiveSession": {
    "module": "Authentication V2",
    "team": "Identity & Access"
  },
  "/v2/profile/sendPrimaryOrSecondaryDeviceOtp/{requestType}": {
    "module": "User Profile V2",
    "team": "User Profile"
  },
  "/v2/profile/sendPrimaryDeviceOtp": {
    "module": "User Profile V2",
    "team": "User Profile"
  },
  "/v2/profile/sendAccountDeactivationOtp": {
    "module": "User Profile V2",
    "team": "User Profile"
  },
  "/v2/profile/removeProfileImage": {
    "module": "User Profile V2",
    "team": "User Profile"
  },
  "/v2/profile/removeCoverImage": {
    "module": "User Profile V2",
    "team": "User Profile"
  },
  "/v2/profile/isDevicePrimaryOrNot": {
    "module": "User Profile V2",
    "team": "User Profile"
  },
  "/v2/profile/getUserProfile": {
    "module": "User Profile V2",
    "team": "User Profile"
  },
  "/v2/profile/getStorageDetails": {
    "module": "User Profile V2",
    "team": "User Profile"
  },
  "/v2/profile/getSignatureImage": {
    "module": "User Profile V2",
    "team": "User Profile"
  },
  "/v2/profile/fetchUserDetails": {
    "module": "User Profile V2",
    "team": "User Profile"
  },
  "/v2/profile/downloadProfileImage/{kpostID}": {
    "module": "User Profile V2",
    "team": "User Profile"
  },
  "/v2/profile/downloadFullProfileImage/{kpostID}": {
    "module": "User Profile V2",
    "team": "User Profile"
  },
  "/v2/profile/downloadCoverImage/{kpostID}": {
    "module": "User Profile V2",
    "team": "User Profile"
  },
  "/v2/knews/getKnewsSettings": {
    "module": "Knews",
    "team": "Knews"
  },
  "/v2/knews/getAllNewsSource": {
    "module": "Knews",
    "team": "Knews"
  },
  "/v2/knews/getAllCategories": {
    "module": "Knews",
    "team": "Knews"
  },
  "/v2/katchup/oldDownload/{uuid}": {
    "module": "Katchup Messaging V2",
    "team": "Messaging"
  },
  "/v2/katchup/mediaStreaming/{uuid}": {
    "module": "Katchup Messaging V2",
    "team": "Messaging"
  },
  "/v2/katchup/getUnopenedMessagesCount": {
    "module": "Katchup Messaging V2",
    "team": "Messaging"
  },
  "/v2/katchup/getUnopenedMessagesAndKmailsTotalCount": {
    "module": "Katchup Messaging V2",
    "team": "Messaging"
  },
  "/v2/katchup/getSharedMessageDetails/{msgID}": {
    "module": "Katchup Messaging V2",
    "team": "Messaging"
  },
  "/v2/katchup/getKatchupMessagesSubject/{selectedContact}": {
    "module": "Katchup Messaging V2",
    "team": "Messaging"
  },
  "/v2/katchup/getDeletedKatchupMsgIds/{lastMsgID}": {
    "module": "Katchup Messaging V2",
    "team": "Messaging"
  },
  "/v2/katchup/getAllReportMsg": {
    "module": "Katchup Messaging V2",
    "team": "Messaging"
  },
  "/v2/katchup/frequentlyAccessContacts": {
    "module": "Katchup Messaging V2",
    "team": "Messaging"
  },
  "/v2/katchup/downloadThumbnail/{uuid}": {
    "module": "Katchup Messaging V2",
    "team": "Messaging"
  },
  "/v2/katchup/downloadFromS3/{uuid}": {
    "module": "Katchup Messaging V2",
    "team": "Messaging"
  },
  "/v2/katchup/downloadAttachment/{uuid}": {
    "module": "Katchup Messaging V2",
    "team": "Messaging"
  },
  "/v2/katchup/download/{uuid}": {
    "module": "Katchup Messaging V2",
    "team": "Messaging"
  },
  "/v2/kall/todayKoolKall": {
    "module": "Kall (Voice/Video) V2 - current",
    "team": "Realtime Communications"
  },
  "/v2/kall/frequentKallContacts": {
    "module": "Kall (Voice/Video) V2 - current",
    "team": "Realtime Communications"
  },
  "/v2/kall/clearKallHistory": {
    "module": "Kall (Voice/Video) V2 - current",
    "team": "Realtime Communications"
  },
  "/v2/group/getGroupDetailsUsingGroupKpostID/{groupKpostID}": {
    "module": "Groups V2",
    "team": "Groups"
  },
  "/v2/group/downloadGroupProfileImage/{groupKpostID}/{kpostID}": {
    "module": "Groups V2",
    "team": "Groups"
  },
  "/v2/group/downloadGroupFullProfileImage/{groupKpostID}/{kpostID}": {
    "module": "Groups V2",
    "team": "Groups"
  },
  "/v2/firebase/notificationForKall": {
    "module": "Firebase Diagnostics",
    "team": "Platform Infrastructure"
  },
  "/v2/ecommerce/getEcommerceDetails": {
    "module": "Integration - E-commerce Catalogue",
    "team": "Commerce Integration"
  },
  "/v2/ecommerce/getAll": {
    "module": "Integration - E-commerce Catalogue",
    "team": "Commerce Integration"
  },
  "/v2/contacts/getblockContactDetails": {
    "module": "Contacts Directory V2",
    "team": "Contacts"
  },
  "/v2/contacts/getImportedPhoneContacts": {
    "module": "Contacts Directory V2",
    "team": "Contacts"
  },
  "/v2/common/msStatus": {
    "module": "Common Reference Data & Utilities V2",
    "team": "Platform Common Services"
  },
  "/v2/common/getStates": {
    "module": "Common Reference Data & Utilities V2",
    "team": "Platform Common Services"
  },
  "/v2/common/getProfession": {
    "module": "Common Reference Data & Utilities V2",
    "team": "Platform Common Services"
  },
  "/v2/common/getFlutterAppVersion": {
    "module": "Common Reference Data & Utilities V2",
    "team": "Platform Common Services"
  },
  "/v2/common/getCompanyNameExistOnKpostAndKsmacc/{companyName}": {
    "module": "Common Reference Data & Utilities V2",
    "team": "Platform Common Services"
  },
  "/v2/common/downloadCompanyLogo/{companyID}": {
    "module": "Common Reference Data & Utilities V2",
    "team": "Platform Common Services"
  },
  "/v2/common/countries": {
    "module": "Common Reference Data & Utilities V2",
    "team": "Platform Common Services"
  },
  "/v2/aws/deleteAttachmentFromS3/{uuid}": {
    "module": "Integration - AWS S3 Pre-signed URLs",
    "team": "Platform Infrastructure"
  },
  "/v2/aws/checkAttachmenS3/{uuid}": {
    "module": "Integration - AWS S3 Pre-signed URLs",
    "team": "Platform Infrastructure"
  },
  "/redbus/updatecitylist": {
    "module": "Integration - RedBus Bus Booking",
    "team": "Travel Integration"
  },
  "/redbus/citysuggestion/{cityname}": {
    "module": "Integration - RedBus Bus Booking",
    "team": "Travel Integration"
  },
  "/kword/documentsType": {
    "module": "KWord Documents",
    "team": "Documents"
  },
  "/kword/documentsType1": {
    "module": "KWord Documents",
    "team": "Documents"
  },
  "/kword/documents/{docId}": {
    "module": "KWord Documents",
    "team": "Documents"
  },
  "/kpresentation/presentations": {
    "module": "KPresentation",
    "team": "Documents"
  },
  "/kpresentation/presentations/{presentationId}": {
    "module": "KPresentation",
    "team": "Documents"
  },
  "/kpresentation/delete": {
    "module": "KPresentation",
    "team": "Documents"
  },
  "/generalSetting/getPersonalize": {
    "module": "General Settings",
    "team": "Platform Common Services"
  },
  "/generalSetting/getAllNotification": {
    "module": "General Settings",
    "team": "Platform Common Services"
  },
  "/dairySchedule/getTodaySchedules": {
    "module": "Kdiary - Schedules, Events & Reports",
    "team": "Kdiary"
  },
  "/dairySchedule/getTodayReport": {
    "module": "Kdiary - Schedules, Events & Reports",
    "team": "Kdiary"
  },
  "/dairySchedule/getEvents": {
    "module": "Kdiary - Schedules, Events & Reports",
    "team": "Kdiary"
  },
  "/crypto/public-key": {
    "module": "Crypto - Payload Encryption Key",
    "team": "Platform Security"
  },
  "/ai/sessions": {
    "module": "Integration - AI Assistant",
    "team": "AI Integration"
  },
  "/ai/sessions/{aiType}": {
    "module": "Integration - AI Assistant",
    "team": "AI Integration"
  },
  "/ai/messages/{sessionId}": {
    "module": "Integration - AI Assistant",
    "team": "AI Integration"
  },
  "/admin/userManagementDetails/{companyID}": {
    "module": "Company Administration",
    "team": "Company Administration"
  },
  "/admin/getBankAndCompanyDetails/{companyID}": {
    "module": "Company Administration",
    "team": "Company Administration"
  },
  "/redbus/getTicket/": {
    "module": "Integration - RedBus Bus Booking",
    "team": "Travel Integration"
  },
  "/redbus/checkBookedTicket/": {
    "module": "Integration - RedBus Bus Booking",
    "team": "Travel Integration"
  },
  "/redbus/boardingPoint/": {
    "module": "Integration - RedBus Bus Booking",
    "team": "Travel Integration"
  }
};
