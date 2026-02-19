// filepath: c:\dev\test-extension\dennis.cs
using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading.Tasks;

namespace DennisApp.Services
{
    /// <summary>
    /// User authentication service for handling JWT tokens and user validation
    /// </summary>
    public class UserAuthService
    {
        private readonly IUserRepository _userRepository;
        private readonly ITokenProvider _tokenProvider;
        private readonly ILogger<UserAuthService> _logger;

        public UserAuthService(IUserRepository userRepository, ITokenProvider tokenProvider, ILogger<UserAuthService> logger)
        {
            _userRepository = userRepository;
            _tokenProvider = tokenProvider;
            _logger = logger;
        }

        /// <summary>
        /// Authenticates user credentials and returns JWT token
        /// </summary>
        public async Task<AuthResult> AuthenticateUserAsync(string email, string password)
        {
            try
            {
                var user = await _userRepository.GetUserByEmailAsync(email);
                
                if (user == null)
                {
                    _logger.LogWarning($"Authentication failed: User not found for email {email}");
                    return new AuthResult { Success = false, Message = "Invalid credentials" };
                }

                if (!user.IsActive)
                {
                    _logger.LogWarning($"Authentication failed: User account inactive for {email}");
                    return new AuthResult { Success = false, Message = "Account is disabled" };
                }

                if (!VerifyPassword(password, user.PasswordHash))
                {
                    _logger.LogWarning($"Authentication failed: Invalid password for {email}");
                    return new AuthResult { Success = false, Message = "Invalid credentials" };
                }

                var token = _tokenProvider.GenerateToken(user.Id, user.Email, user.Role);
                user.LastLoginDate = DateTime.UtcNow;
                await _userRepository.UpdateUserAsync(user);

                _logger.LogInformation($"User successfully authenticated: {email}");
                
                return new AuthResult 
                { 
                    Success = true, 
                    Token = token,
                    ExpiresIn = 3600,
                    Message = "Authentication successful"
                };
            }
            catch (Exception ex)
            {
                _logger.LogError($"Error during authentication: {ex.Message}");
                return new AuthResult { Success = false, Message = "An error occurred during authentication" };
            }
        }

        /// <summary>
        /// Validates JWT token and returns user claims
        /// </summary>
        public async Task<UserClaims> ValidateTokenAsync(string token)
        {
            if (string.IsNullOrWhiteSpace(token))
            {
                return null;
            }

            try
            {
                var claims = _tokenProvider.ValidateToken(token);
                if (claims == null)
                {
                    return null;
                }

                var userId = claims.FindFirst("userId")?.Value;
                var user = await _userRepository.GetUserByIdAsync(userId);

                return new UserClaims 
                { 
                    UserId = userId, 
                    Email = user?.Email,
                    Role = user?.Role,
                    IsValid = true
                };
            }
            catch (Exception ex)
            {
                _logger.LogError($"Token validation failed: {ex.Message}");
                return null;
            }
        }

        private bool VerifyPassword(string rawPassword, string hash)
        {
            return BCrypt.Net.BCrypt.Verify(rawPassword, hash);
        }
    }

    public class AuthResult
    {
        public bool Success { get; set; }
        public string Token { get; set; }
        public int ExpiresIn { get; set; }
        public string Message { get; set; }
    }

    public class UserClaims
    {
        public string UserId { get; set; }
        public string Email { get; set; }
        public string Role { get; set; }
        public bool IsValid { get; set; }
    }
}